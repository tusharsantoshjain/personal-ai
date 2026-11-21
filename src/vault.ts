import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFileAtomic } from './files.ts';
import { findSecrets } from './secrets.ts';

export class VaultPathError extends Error {}
export class SecretError extends Error {}

/**
 * Resolve a vault-relative path safely: no absolute paths, no traversal, and no symlink
 * (junction) escape out of the vault root.
 */
export function safeVaultPath(vault: string, rel: string): string {
  if (!rel || isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel))
    throw new VaultPathError(`not a vault-relative path: ${rel}`);
  const norm = normalize(rel);
  if (norm === '..' || norm.startsWith('..' + sep) || norm.split(sep).includes('..'))
    throw new VaultPathError(`path traversal: ${rel}`);
  const root = realpathSync(vault);
  const abs = join(root, norm);
  // Walk up to the deepest existing ancestor and make sure its real path stays inside the vault.
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + sep))
    throw new VaultPathError(`path escapes the vault through a link: ${rel}`);
  return abs;
}

/** Atomic write: temp file in the same folder, then rename. Refuses secret-shaped text. */
export function writeVaultFile(
  vault: string,
  rel: string,
  input: string,
  opts: { allowSecrets?: boolean } = {},
): string {
  const abs = safeVaultPath(vault, rel);
  const content = input.replace(/\r\n?/g, '\n'); // the vault is LF only (.gitattributes)
  if (!opts.allowSecrets) {
    const hits = findSecrets(content);
    if (hits.length)
      throw new SecretError(`refusing to write ${rel}: secret-shaped text (${hits.map((h) => h.kind).join(', ')})`);
  }
  writeFileAtomic(abs, content);
  return abs;
}

/** Write only when the content differs, so re-running a sync changes nothing. Returns true when written. */
export function writeIfChanged(vault: string, rel: string, content: string): boolean {
  const abs = safeVaultPath(vault, rel);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === content.replace(/\r\n?/g, '\n')) return false;
  writeVaultFile(vault, rel, content);
  return true;
}

export function readVaultFile(vault: string, rel: string): string | undefined {
  const abs = safeVaultPath(vault, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

export interface Note {
  data: Record<string, unknown>;
  body: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(text: string): Note {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text };
  let data: unknown;
  try {
    data = parse(m[1] ?? '');
  } catch {
    data = {};
  }
  return {
    data: (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>,
    body: text.slice(m[0].length),
  };
}

export function renderNote(note: Note): string {
  const keys = Object.keys(note.data);
  if (!keys.length) return note.body;
  const fm = stringify(note.data, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).trimEnd();
  return `---\n${fm}\n---\n${note.body.startsWith('\n') ? note.body.slice(1) : note.body}`;
}

/** "[[Name]]" or "Name" to "Name". */
export const unwikilink = (value: unknown): string => String(value ?? '').replace(/^\[\[|\]\]$/g, '');

/** A new note with a title heading, dated today. */
export const stubNote = (title: string, data: Record<string, unknown>, day: string): Note => ({
  data: { ...data, created: day, updated: day },
  body: `# ${title}\n`,
});

/**
 * Append a line under `## <section>` of a note, creating the note from `seed` when it is missing,
 * and set `updated` to `day`. Returns false when the line was already there.
 */
export function appendLineToNote(
  vault: string,
  rel: string,
  section: string,
  line: string,
  day: string,
  seed: () => Note,
): boolean {
  const existing = readVaultFile(vault, rel);
  const note = existing === undefined ? seed() : parseNote(existing);
  const body = appendToSection(note.body, section, line);
  if (existing !== undefined && body === note.body) return false;
  note.body = body;
  note.data.updated = day;
  writeVaultFile(vault, rel, renderNote(note));
  return true;
}

const blockRe = (id: string) => new RegExp(`<!-- sync:${id}:start -->[\\s\\S]*?<!-- sync:${id}:end -->`);

/**
 * Replace the generated block owned by a sync, keeping everything outside it.
 * If the block is missing it is inserted after the frontmatter heading area (top of body).
 */
export function upsertSyncBlock(body: string, id: string, content: string): string {
  const block = `<!-- sync:${id}:start -->\n${content.trimEnd()}\n<!-- sync:${id}:end -->`;
  if (blockRe(id).test(body)) return body.replace(blockRe(id), () => block);
  const h1 = /^# .*\n/m.exec(body);
  if (h1 && h1.index === body.search(/\S/)) {
    const at = h1.index + h1[0].length;
    return `${body.slice(0, at)}${block}\n${body.slice(at)}`;
  }
  return `${block}\n${body}`;
}

export function getSyncBlock(body: string, id: string): string | undefined {
  const m = blockRe(id).exec(body);
  return m ? m[0].replace(`<!-- sync:${id}:start -->\n`, '').replace(`\n<!-- sync:${id}:end -->`, '') : undefined;
}

/** Append a line under a `## <section>` heading, creating the section at the end if missing. No-op if the line exists. */
export function appendToSection(body: string, section: string, line: string): string {
  if (body.split('\n').includes(line)) return body;
  const head = `## ${section}`;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() === head);
  if (i === -1) return `${body.trimEnd()}\n\n${head}\n${line}\n`;
  let j = i + 1;
  while (j < lines.length && !/^#{1,2} /.test(lines[j] ?? '')) j++;
  while (j > i + 1 && (lines[j - 1] ?? '').trim() === '') j--;
  lines.splice(j, 0, line);
  return lines.join('\n');
}

/** Replace em and en dashes in generated text (vault convention 9); 95-Sources keep the raw text. */
export const dedash = (s: string): string => s.replace(/\s*[\u2014\u2013]\s*/g, ' - ');
const dedashDeep = (v: unknown): unknown =>
  typeof v === 'string' ? dedash(v) : Array.isArray(v) ? v.map(dedashDeep) : v;

/** Update a note's sync block and frontmatter keys, creating the note if needed. Returns true when the file changed. */
export function upsertNote(
  vault: string,
  rel: string,
  opts: { data?: Record<string, unknown>; blockId?: string; block?: string; title?: string; preserveKeys?: string[] },
): boolean {
  const existing = readVaultFile(vault, rel);
  const note: Note = existing ? parseNote(existing) : { data: {}, body: opts.title ? `# ${dedash(opts.title)}\n` : '' };
  if (opts.data) {
    for (const [k, v] of Object.entries(opts.data)) {
      if (existing && opts.preserveKeys?.includes(k) && note.data[k] !== undefined) continue;
      if (v === undefined) continue;
      note.data[k] = dedashDeep(v);
    }
  }
  if (opts.blockId && opts.block !== undefined)
    note.body = upsertSyncBlock(note.body, opts.blockId, dedash(opts.block));
  return writeIfChanged(vault, rel, renderNote(note));
}

export interface VaultNote extends Note {
  path: string;
  name: string;
}

/** Every note under a vault-relative folder, parsed. */
export function readNotesIn(vault: string, folder: string): VaultNote[] {
  return listNotes(vault)
    .filter((path) => path.startsWith(folder + '/'))
    .map((path) => ({ path, name: basename(path, '.md'), ...parseNote(readVaultFile(vault, path) ?? '') }));
}

/** Walk the vault for markdown files, skipping excluded folders. Paths are vault-relative with forward slashes. */
export function listNotes(vault: string, exclude: string[] = []): string[] {
  const out: string[] = [];
  const skip = new Set(['.obsidian', '.git', '.trash', ...exclude]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(vault, abs).split(sep).join('/');
      // Dot folders (.git, .obsidian, .claude worktrees holding a second copy of the vault) are never notes.
      if (e.name.startsWith('.') || [...skip].some((s) => rel === s || rel.startsWith(s + '/'))) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
    }
  };
  if (existsSync(vault) && statSync(vault).isDirectory()) walk(vault);
  return out.sort();
}

/** File names must be safe on macOS and Windows and in wikilinks. */
export function safeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
