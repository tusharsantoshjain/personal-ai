import { basename } from 'node:path';

/**
 * Small, conservative shell parser for the gate. It is not a full POSIX parser: it splits a command
 * line into simple commands, strips quotes, pulls out heredoc bodies, redirect targets and the
 * contents of $(...) so that nested commands are classified too. When unsure it keeps text, so the
 * gate sees more rather than less.
 */
export interface Segment {
  argv: string[];
  raw: string;
  heredocs: string[];
  redirects: string[];
  nested: boolean; // came from $(...) or bash -c
}

const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;

function extractHeredocs(cmd: string): { text: string; bodies: string[] } {
  const lines = cmd.split('\n');
  const out: string[] = [];
  const bodies: string[] = [];
  const pending: { delim: string; dash: boolean }[] = [];
  let body: string[] = [];
  for (const line of lines) {
    if (pending.length) {
      const p = pending[0]!;
      if ((p.dash ? line.trim() : line) === p.delim) {
        bodies.push(body.join('\n'));
        body = [];
        pending.shift();
      } else body.push(line);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(HEREDOC)) pending.push({ delim: m[3]!, dash: m[1] === '-' });
  }
  if (pending.length) bodies.push(body.join('\n'));
  return { text: out.join('\n'), bodies };
}

/** Split on ; && || | & and newlines outside quotes and outside $( ). Returns raw segment strings and $( ) bodies. */
function split(text: string): { parts: string[]; subs: string[] } {
  const parts: string[] = [];
  const subs: string[] = [];
  let cur = '';
  let q: '' | "'" | '"' = '';
  let depth = 0;
  let subStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === '\\' && q !== "'") {
      cur += c + (n ?? '');
      i++;
      continue;
    }
    if (q === "'") {
      if (c === "'") q = '';
      cur += c;
      continue;
    }
    if (c === '$' && n === '(') {
      if (depth === 0) subStart = cur.length + 2;
      depth++;
      cur += '$(';
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) subs.push(cur.slice(subStart));
      }
      cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = '';
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        subs.push(text.slice(i + 1, end));
        cur += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    const sep = c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')';
    if (sep) {
      // keep redirects like 2>&1 and &> inside the segment
      if (c === '&' && (cur.endsWith('>') || n === '>')) {
        cur += c;
        continue;
      }
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if ((c === '&' && n === '&') || (c === '|' && n === '|')) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return { parts, subs };
}

/** Tokenize one simple command into argv (quotes removed) and redirect targets. */
export function tokenize(seg: string): { argv: string[]; redirects: string[] } {
  const argv: string[] = [];
  const redirects: string[] = [];
  let cur = '';
  let has = false;
  let q: '' | "'" | '"' = '';
  let redirectNext = false;
  const push = () => {
    if (!has) return;
    if (redirectNext) {
      redirects.push(cur);
      redirectNext = false;
    } else argv.push(cur);
    cur = '';
    has = false;
  };
  let sub = 0; // depth inside $( ... ): keep it as one word, spaces included
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (q === '' && c === '$' && seg[i + 1] === '(') {
      sub++;
      cur += '$(';
      has = true;
      i++;
      continue;
    }
    if (sub > 0 && q === '') {
      if (c === '(') sub++;
      else if (c === ')') sub--;
      cur += c;
      continue;
    }
    if (q === "'") {
      if (c === "'") q = '';
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '\\' && /["\\$`]/.test(seg[i + 1] ?? '')) {
        cur += seg[++i];
      } else cur += c;
      continue;
    }
    if (c === '\\') {
      cur += seg[++i] ?? '';
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '>' || (c === '<' && seg[i + 1] !== '<')) {
      // n>file, >>file, &>file, 2>&1 ; strip a leading fd number already in cur
      if (/^\d*$/.test(cur) || cur === '&') {
        cur = '';
        has = false;
      } else push();
      while (seg[i + 1] === '>' || seg[i + 1] === '&' || seg[i + 1] === '|') i++;
      if (seg[i] === '&' && /\d/.test(seg[i + 1] ?? '')) {
        while (/\d/.test(seg[i + 1] ?? '')) i++;
        continue;
      }
      redirectNext = c === '>';
      if (c === '<') redirectNext = false;
      continue;
    }
    if (c === '<' && seg[i + 1] === '<') {
      push();
      while (seg[i + 1] === '<' || seg[i + 1] === '-') i++;
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return { argv, redirects };
}

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'caffeinate']);
// Shell words that can sit in front of a command: `do git push`, `then rm -rf x`, `{ git push; }`, `! git push`.
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Command name without its folder (`/usr/bin/git` is `git`); assignments and $(...) stay as they are. */
const commandName = (word: string) => (ASSIGNMENT.test(word) || word.startsWith('$') ? word : basename(word));

/** Remove leading VAR=value assignments, shell keywords and wrappers like sudo, env, `<x>-scfw run`. */
export function unwrap(argv: string[]): string[] {
  let a = [...argv];
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const head = commandName(a[0]!);
    if (ASSIGNMENT.test(head) || WRAPPERS.has(head) || SHELL_KEYWORDS.has(head)) {
      a = a.slice(1);
      continue;
    }
    if (head === 'env' && a.length > 1) {
      a = a.slice(1);
      while (a[0]?.startsWith('-')) a = a.slice(1);
      continue;
    }
    if (/(^|-)scfw$/.test(head) && a[1] === 'run') {
      a = a.slice(2);
      continue;
    } // supply-chain firewall wrappers
    if (head === 'xargs') {
      a = a.slice(1);
      while (a[0]?.startsWith('-')) a = a.slice(a[0] === '-I' || a[0] === '-n' || a[0] === '-P' ? 2 : 1);
      continue;
    }
    if (head === 'npx' || head === 'pnpx' || head === 'bunx') {
      a = a.slice(1);
      while (a[0]?.startsWith('-')) a = a.slice(1);
      continue;
    }
    break;
  }
  if (a.length) a[0] = commandName(a[0]!);
  return a;
}

export function parseShell(cmd: string, nested = false, depth = 0): Segment[] {
  const { text, bodies } = extractHeredocs(cmd);
  const { parts, subs } = split(text);
  const segs: Segment[] = [];
  const queue = [...bodies];
  for (const raw of parts) {
    const markers = [...raw.matchAll(HEREDOC)].length;
    const heredocs = queue.splice(0, markers);
    const { argv, redirects } = tokenize(raw);
    const a = unwrap(argv);
    segs.push({ argv: a, raw, heredocs, redirects, nested });
    if (depth < 3 && ['bash', 'sh', 'zsh'].includes(a[0] ?? '')) {
      const ci = a.indexOf('-c');
      const lc = a.findIndex((x) => /^-\w*c$/.test(x));
      const idx = ci >= 0 ? ci : lc;
      if (idx >= 0 && a[idx + 1]) segs.push(...parseShell(a[idx + 1]!, true, depth + 1));
    }
    if (depth < 3 && a[0] === 'eval') segs.push(...parseShell(a.slice(1).join(' '), true, depth + 1));
  }
  if (depth < 3)
    for (const s of subs) {
      const inner = parseShell(s, true, depth + 1);
      // a heredoc inside $(...) belongs to the outer command too (git commit -m "$(cat <<EOF ...)")
      for (const seg of inner)
        if (!seg.heredocs.length && /<</.test(seg.raw) && queue.length) seg.heredocs = queue.splice(0, 1);
      segs.push(...inner);
    }
  // Heredoc bodies used by $(cat <<EOF) inside an argument: attach leftovers to the segment that holds the marker text.
  if (queue.length)
    for (const s of segs) if (!s.nested && /<</.test(s.raw) && !s.heredocs.length) s.heredocs = queue.splice(0, 1);
  return segs;
}
