import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Config } from './config.ts';
import { tryGit } from './git.ts';

export interface LooseEnd {
  kind: 'unpushed' | 'uncommitted' | 'draft';
  where: string;
  detail: string;
}

// shortcut: drafts are found by name and age only; a sent draft stays listed until it is 14 days old or deleted.
const DRAFT = /(signoff|sign-off|comment|message|repl(y|ies)|slack|scrum)[^/]*\.(md|txt)$|\.patch$/i;
const DRAFT_DAYS = 14;
const RECENT_DAYS = 14;

// Output keeps leading spaces: porcelain status lines start with one.
const git = (cwd: string, ...args: string[]) => tryGit(cwd, args, { timeoutMs: 30_000 });

/** Worktree paths of one repo (the main checkout first). */
export function worktrees(repo: string): string[] {
  const out = git(repo, 'worktree', 'list', '--porcelain');
  if (out === undefined) return [];
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))
    .filter((p) => existsSync(p));
}

/** Main checkouts (a `.git` folder, not a worktree's `.git` file) up to 3 levels under the workspace, plus configured repos. */
function findRepos(ws: string, extra: string[]): string[] {
  const found = new Set(extra.filter((p) => existsSync(join(p, '.git')) && statSync(join(p, '.git')).isDirectory()));
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git' && e.isDirectory())) {
      found.add(dir);
      return;
    }
    if (depth < 3)
      for (const e of entries)
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1);
  };
  walk(ws, 0);
  return [...found].sort();
}

/** Every main checkout the assistant knows: the configured repos plus any found under the workspace. */
export function workspaceRepos(cfg: Config): string[] {
  const ws = cfg.paths.workspace;
  return findRepos(
    ws,
    cfg.repositories.map((r) => (isAbsolute(r.path) ? r.path : join(ws, r.path))),
  );
}

/** Work started but not finished: local commits on no remote, uncommitted worktree changes, recent drafts in .scratch. */
export function looseEnds(cfg: Config, now = Date.now()): LooseEnd[] {
  const ends: LooseEnd[] = [];
  const ws = cfg.paths.workspace;
  const rel = (p: string) => relative(ws, p) || '.';
  for (const repo of workspaceRepos(cfg)) {
    const r = { name: basename(repo) };
    // Repos with no remote (like the vault) are local by design; only branches touched in the last RECENT_DAYS count.
    const remoted = !!git(repo, 'remote');
    for (const row of remoted
      ? (git(repo, 'for-each-ref', '--format=%(committerdate:unix) %(refname:short)', 'refs/heads') ?? '')
          .split('\n')
          .filter(Boolean)
      : []) {
      const [at, line] = [Number(row.slice(0, row.indexOf(' '))) * 1000, row.slice(row.indexOf(' ') + 1)];
      if (now - at > RECENT_DAYS * 86_400_000) continue;
      const n = Number(git(repo, 'rev-list', '--count', line, '--not', '--remotes') ?? 0);
      if (n > 0)
        ends.push({
          kind: 'unpushed',
          where: `${r.name} ${line}`,
          detail: `${n} commit${n > 1 ? 's' : ''} on no remote`,
        });
    }
    for (const wt of worktrees(repo)) {
      const paths = (git(wt, 'status', '--porcelain', '--untracked-files=no') ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => join(wt, l.slice(3).replace(/^.* -> /, '')));
      if (
        !paths.some((f) => {
          try {
            return now - statSync(f).mtimeMs < RECENT_DAYS * 86_400_000;
          } catch {
            return true;
          }
        })
      )
        continue;
      const changed = paths.length;
      if (changed)
        ends.push({
          kind: 'uncommitted',
          where: rel(wt),
          detail: `${changed} changed file${changed > 1 ? 's' : ''} (${git(wt, 'branch', '--show-current') || 'detached'})`,
        });
    }
  }
  const scratch = join(ws, '.scratch');
  const walk = (dir: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith('_') && e.name !== 'claude-logs') walk(p, depth + 1);
      else if (e.isFile() && DRAFT.test(e.name) && now - statSync(p).mtimeMs < DRAFT_DAYS * 86_400_000)
        ends.push({ kind: 'draft', where: rel(p), detail: `${basename(dir)} draft, not known to be sent` });
    }
  };
  if (existsSync(scratch)) walk(scratch, 0);
  return ends;
}

export function formatLooseEnds(ends: LooseEnd[]): string[] {
  if (!ends.length) return ['- none'];
  const label = { unpushed: 'Not pushed', uncommitted: 'Not committed', draft: 'Drafts' } as const;
  return (['unpushed', 'uncommitted', 'draft'] as const).flatMap((k) => {
    const xs = ends.filter((e) => e.kind === k);
    return xs.length ? [`- ${label[k]}:`, ...xs.map((e) => `  - \`${e.where}\` ${e.detail}`)] : [];
  });
}
