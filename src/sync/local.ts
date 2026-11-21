import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Config } from '../config.ts';
import { trackerKeyPattern, vaultFolder } from '../config.ts';
import { readJson, writeFileAtomic } from '../files.ts';
import { tryGit } from '../git.ts';
import { ticketsIn } from '../prs.ts';
import { findSecrets, maskSecrets } from '../secrets.ts';
import { scrub } from '../scrub.ts';
import { appendTicketLog } from '../promote.ts';
import { listTranscripts, parseTranscript } from '../transcripts.ts';
import { addEvents, localDay, localStamp, type TimelineEvent } from '../timeline.ts';
import {
  dedash,
  parseNote,
  readNotesIn,
  readVaultFile,
  safeFileName,
  unwikilink,
  upsertNote,
  writeIfChanged,
} from '../vault.ts';
import { emptyReport, type SyncReport } from './report.ts';

const RESULT_TICKET_DAYS = 3; // result lines reach ticket notes only when this recent, so a first run does not backfill history into them

/**
 * One timeline event per Claude session, titled by the owner's first prompt; tickets mentioned become links.
 * Each `result:` line the assistant ended an answer with becomes a session-result event, and, when recent, a line in the linked ticket's Log.
 */
export function syncSessions(cfg: Config, now = Date.now()): SyncReport {
  const rep = emptyReport('sessions');
  const since = Date.parse(cfg.github.since);
  const events: TimelineEvent[] = [];
  const key = trackerKeyPattern(cfg);
  const isKey = (k: string) => key.test(k);
  for (const t of listTranscripts(cfg.paths.claude_projects, since)) {
    if (t.subagent) continue;
    const s = parseTranscript(t.file, t.project);
    if (!s || !s.prompts.length || Date.parse(s.start) < since) {
      rep.skipped++;
      continue;
    }
    const first = s.prompts[0]!.replace(/\s+/g, ' ');
    const title = findSecrets(first).length
      ? '(prompt withheld: secret-shaped text)'
      : scrub(cfg, maskSecrets(first)).slice(0, 100);
    const where = s.cwd ? basename(s.cwd) : t.project;
    const tickets = ticketsIn(...s.prompts.map((p) => p.slice(0, 2000)), s.branch).filter(isKey);
    events.push({
      ts: localStamp(cfg, s.start),
      type: 'session',
      title: `${where}${s.branch ? ` (${s.branch})` : ''}: ${title} [${s.prompts.length} prompts]`,
      links: tickets.slice(0, 5),
      src: 'session',
      id: `session-${s.id}`,
    });
    for (const r of s.results) {
      if (findSecrets(r.text).length) {
        rep.skipped++;
        continue;
      }
      const text = dedash(scrub(cfg, maskSecrets(r.text.replace(/\s+/g, ' ')))).slice(0, 400);
      const own = ticketsIn(r.text).filter(isKey);
      // A result naming no ticket belongs to the session's ticket only when the session had exactly one.
      const links = own.length ? own : tickets.length === 1 ? tickets : [];
      const ts = localStamp(cfg, r.ts || s.start);
      events.push({
        ts,
        type: 'session-result',
        title: `${where}: ${text}`,
        links: links.slice(0, 5),
        src: 'session',
        id: `result-${createHash('sha1')
          .update(s.id + r.text)
          .digest('hex')
          .slice(0, 12)}`,
      });
      if (Date.parse(r.ts) >= now - RESULT_TICKET_DAYS * 86_400_000)
        for (const k of links)
          if (appendTicketLog(cfg, k, ts.slice(0, 10), `- ${ts.slice(0, 10)} result: ${text}`)) rep.notes++;
    }
  }
  rep.events = addEvents(cfg, events);
  return rep;
}

const DOC_NAMES = /^(README|CONTRIBUTING|CHANGELOG|CLAUDE|AGENTS|ARCHITECTURE|SECURITY)[^/]*\.md$/i;

function repoDocs(root: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (existsSync(p) && statSync(p).isFile()) out.push(p);
  };
  for (const f of existsSync(root) ? readdirSync(root) : []) if (DOC_NAMES.test(f)) add(join(root, f));
  for (const f of [
    '.github/copilot-instructions.md',
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/CODEOWNERS',
    'CODEOWNERS',
  ])
    add(join(root, f));
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth > 2) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.md') && out.length < 80) out.push(p);
    }
  };
  walk(join(root, 'docs'), 0);
  walk(join(root, '.github', 'instructions'), 0);
  return [...new Set(out)];
}

/** Index of the docs each repo already has (path, first heading, modified date). Content stays in the repo. */
export function syncDocs(cfg: Config): SyncReport {
  const rep = emptyReport('docs');
  for (const r of cfg.repositories) {
    const root = join(cfg.paths.workspace, r.path);
    if (!existsSync(root)) {
      rep.skipped++;
      continue;
    }
    const rows = repoDocs(root).map((p) => {
      const text = readFileSync(p, 'utf8');
      const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim().replace(/\|/g, '/') ?? '';
      return `| \`${relative(root, p)}\` | ${h.slice(0, 80)} | ${localDay(cfg, statSync(p).mtime)} |`;
    });
    if (!rows.length) {
      rep.skipped++;
      continue;
    }
    const rel = `${vaultFolder(cfg, 'sources')}/Docs/${r.name}.md`;
    if (
      upsertNote(cfg.paths.vault, rel, {
        data: { type: 'source', source: 'repo-docs', repo: `[[${r.name}]]` },
        blockId: 'docs',
        block: ['| Path | Title | Modified |', '| --- | --- | --- |', ...rows].join('\n'),
        title: `${r.name} docs`,
      })
    )
      rep.notes++;
  }
  return rep;
}

/**
 * Merge Claude memory from every project memory folder into the vault memory folder. Same name and
 * same content is skipped; same name with different content is kept as <name>--<project>.md and reported.
 */
export function syncMemory(cfg: Config): SyncReport {
  const rep = emptyReport('memory');
  // Source files already imported (by content hash) are skipped, so hand merges in the vault stick.
  const seenPath = join(cfg.paths.cache_dir, 'memory-imported.json');
  const seen = readJson<Record<string, string>>(seenPath, {}); // source path -> content hash
  const memRel = cfg.vault.memory_folder;
  const memAbs = join(cfg.paths.vault, memRel);
  const projects = existsSync(cfg.paths.claude_projects) ? readdirSync(cfg.paths.claude_projects) : [];
  for (const p of projects) {
    const dir = join(cfg.paths.claude_projects, p, 'memory');
    if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink() || (existsSync(memAbs) && realpathSync(dir) === realpathSync(memAbs))) continue;
    for (const f of readdirSync(dir)) {
      const src = join(dir, f);
      if (!f.endsWith('.md') || f === 'MEMORY.md' || !statSync(src).isFile()) continue;
      const content = readFileSync(src, 'utf8');
      const hash = createHash('sha1').update(content).digest('hex');
      if (seen[src] === hash) {
        rep.skipped++;
        continue;
      }
      seen[src] = hash;
      if (findSecrets(content).length) {
        rep.errors.push(`${p}/memory/${f}: secret-shaped text, not copied`);
        continue;
      }
      const existing = readVaultFile(cfg.paths.vault, `${memRel}/${f}`);
      if (existing === undefined) {
        writeIfChanged(cfg.paths.vault, `${memRel}/${f}`, content);
        rep.notes++;
        continue;
      }
      if (existing.trim() === content.trim()) {
        rep.skipped++;
        continue;
      }
      const slug = cfg.paths.claude_project_slug; // the workspace's own project folder; others are named relative to it
      const short = (p.startsWith(slug) ? p.slice(slug.length).replace(/^-/, '') : p) || 'root';
      const alt = `${f.replace(/\.md$/, '')}--${safeFileName(short)}.md`;
      if (writeIfChanged(cfg.paths.vault, `${memRel}/${alt}`, content)) {
        rep.notes++;
        rep.errors.push(`conflict: ${f} differs in ${p}; kept as ${alt}, merge by hand`);
      }
    }
  }
  writeFileAtomic(seenPath, JSON.stringify(seen));
  if (rebuildMemoryIndex(cfg)) rep.notes++;
  return rep;
}

export function rebuildMemoryIndex(cfg: Config): boolean {
  const memRel = cfg.vault.memory_folder;
  const memAbs = join(cfg.paths.vault, memRel);
  if (!existsSync(memAbs)) return false;
  const lines = readdirSync(memAbs)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort()
    .map((f) => {
      const { data, body } = parseNote(readFileSync(join(memAbs, f), 'utf8'));
      const title = String(data.name ?? f.replace(/\.md$/, ''));
      const hook = String(data.description ?? body.split('\n').find((l) => l.trim()) ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 150);
      return `- [${title}](${f}) - ${dedash(hook)}`;
    });
  return writeIfChanged(cfg.paths.vault, `${memRel}/MEMORY.md`, `${lines.join('\n')}\n`);
}

/** People notes: one per known person, with a generated block of their PRs, reviews and tickets. */
export function syncPeople(cfg: Config): SyncReport {
  const rep = emptyReport('people');
  const names = new Set(Object.values(cfg.people.aliases));
  const prs = vaultFolder(cfg, 'prs');
  const tickets = vaultFolder(cfg, 'tracker');
  const authored = new Map<string, string[]>();
  const reviewed = new Map<string, string[]>();
  const assigned = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  const logins = new Map<string, Set<string>>();
  for (const { name: n, data } of [...readNotesIn(cfg.paths.vault, prs), ...readNotesIn(cfg.paths.vault, tickets)]) {
    if (data.type === 'pr') {
      const a = unwikilink(data.author);
      if (a && a !== 'unknown') {
        push(authored, a, n);
        names.add(a);
        if (typeof data.author_login === 'string' && data.author_login !== a)
          logins.set(a, new Set([...(logins.get(a) ?? []), data.author_login]));
      }
      for (const r of (data.reviewers as string[] | undefined) ?? []) {
        push(reviewed, unwikilink(r), n);
        names.add(unwikilink(r));
      }
    } else if (data.type === 'ticket') {
      const a = unwikilink(data.assignee);
      if (a) {
        push(assigned, a, n);
        names.add(a);
      }
    }
  }
  for (const name of names) {
    if (!name || /\[bot\]$/.test(name) || name.startsWith('app/') || cfg.people.bots.includes(name)) continue;
    const aliases = [
      ...Object.entries(cfg.people.aliases)
        .filter(([, v]) => v === name)
        .map(([k]) => k),
      ...(logins.get(name) ?? []),
    ];
    const rel = `${vaultFolder(cfg, 'people')}/${safeFileName(name)}.md`;
    const existing = parseNote(readVaultFile(cfg.paths.vault, rel) ?? '').data;
    const mergedAliases = [...new Set([...((existing.aliases as string[] | undefined) ?? []), ...aliases])];
    const recent = (xs: string[] = []) =>
      xs
        .slice(-15)
        .map((x) => `[[${x}]]`)
        .join(', ') || 'none';
    const block = [
      `PRs authored (${authored.get(name)?.length ?? 0}): ${recent(authored.get(name))}`,
      `PRs reviewed (${reviewed.get(name)?.length ?? 0}): ${recent(reviewed.get(name))}`,
      `Tickets assigned (${assigned.get(name)?.length ?? 0}): ${recent(assigned.get(name))}`,
    ].join('\n');
    if (
      upsertNote(cfg.paths.vault, rel, {
        data: { type: 'person', aliases: mergedAliases, role: existing.role ?? 'TBD', team: existing.team ?? 'TBD' },
        preserveKeys: ['role', 'team'],
        blockId: 'people',
        block,
        title: name,
      })
    )
      rep.notes++;
  }
  return rep;
}

/** Repo cards: generated facts in a sync block; Purpose, Validation recipe and Traps stay hand-written. */
export function syncRepos(cfg: Config): SyncReport {
  const rep = emptyReport('repos');
  for (const r of cfg.repositories) {
    const root = join(cfg.paths.workspace, r.path);
    if (!existsSync(root)) {
      rep.skipped++;
      continue;
    }
    const facts: string[] = [];
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          scripts?: Record<string, string>;
          engines?: Record<string, string>;
          packageManager?: string;
        };
        facts.push(
          `Scripts: ${
            Object.keys(pkg.scripts ?? {})
              .map((s) => `\`${s}\``)
              .join(', ') || 'none'
          }`,
        );
        if (pkg.engines)
          facts.push(
            `Engines: ${Object.entries(pkg.engines)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}`,
          );
        if (pkg.packageManager) facts.push(`Package manager: ${pkg.packageManager}`);
      } catch {
        rep.errors.push(`${r.name}: package.json unreadable`);
      }
    }
    for (const f of ['.nvmrc', '.node-version', 'mise.toml', '.tool-versions'])
      if (existsSync(join(root, f)))
        facts.push(
          `${f}: ${readFileSync(join(root, f), 'utf8').trim().split('\n').slice(0, 3).join('; ').slice(0, 120)}`,
        );
    if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts')))
      facts.push('Gradle build (use ./gradlew)');
    const lock = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'].filter((f) => existsSync(join(root, f)));
    if (lock.length) facts.push(`Lockfiles: ${lock.join(', ')}`);
    const wf = join(root, '.github', 'workflows');
    const ci = [
      ...(existsSync(wf) ? readdirSync(wf).map((f) => `.github/workflows/${f}`) : []),
      ...readdirSync(root).filter((f) =>
        /^buildspec.*\.ya?ml$|^sonar-project\.properties$|^Jenkinsfile$|^lefthook\.yml$/.test(f),
      ),
    ];
    if (ci.length) facts.push(`CI: ${ci.join(', ')}`);
    const head = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
    facts.push(`Default branch: ${r.default_branch}${head ? ` | checked out: ${head}` : ' | not a git checkout'}`);
    const rel = `${vaultFolder(cfg, 'repositories')}/${r.name}.md`;
    const isNew = !readVaultFile(cfg.paths.vault, rel);
    const changed = upsertNote(cfg.paths.vault, rel, {
      data: {
        type: 'repository',
        stack: r.stack,
        org: r.org,
        project: `[[${r.project}]]`,
        path: r.path,
        default_branch: r.default_branch,
        read_only: r.read_only ?? false,
      },
      blockId: 'repo',
      block: facts.join('\n'),
      title: r.name,
    });
    if (isNew) {
      const text = readVaultFile(cfg.paths.vault, rel)!;
      writeIfChanged(
        cfg.paths.vault,
        rel,
        `${text.trimEnd()}\n\n## Purpose\n${r.purpose ?? 'TBD'}\n\n## Validation recipe\nTBD (exact commands on changed files)\n\n## Traps\nTBD\n`,
      );
    }
    if (changed) rep.notes++;
  }
  return rep;
}

export const stableId = (...parts: string[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
