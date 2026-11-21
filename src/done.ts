import { existsSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Config } from './config.ts';
import { tryGit } from './git.ts';
import { workspaceRepos, worktrees } from './loose.ts';

/**
 * Clean up after a finished ticket: remove its worktrees (`<repo>-wt-<ticket>`) and its scratch folder.
 * A worktree with uncommitted changes or commits on no remote is kept and reported, and then the scratch folder stays too.
 */
export function finishTicket(cfg: Config, ticket: string): string[] {
  if (!/^[\w.-]+$/.test(ticket) || /^\.+$/.test(ticket)) throw new Error(`not a ticket or folder name: "${ticket}"`);
  const ws = cfg.paths.workspace;
  const lines: string[] = [];
  let kept = 0;
  for (const repo of workspaceRepos(cfg)) {
    for (const worktree of worktrees(repo)) {
      if (worktree === repo || !basename(worktree).endsWith(`-wt-${ticket}`)) continue;
      const where = relative(ws, worktree);
      const unpushed = Number(tryGit(worktree, ['rev-list', '--count', 'HEAD', '--not', '--remotes']) ?? 0);
      const reasonToKeep = tryGit(worktree, ['status', '--porcelain'])
        ? 'it has uncommitted changes'
        : unpushed
          ? `${unpushed} commit${unpushed > 1 ? 's are' : ' is'} on no remote`
          : tryGit(repo, ['worktree', 'remove', worktree]) === undefined
            ? 'git refused to remove it'
            : undefined;
      if (reasonToKeep) kept++;
      lines.push(reasonToKeep ? `kept ${where}: ${reasonToKeep}` : `removed worktree ${where}`);
    }
  }
  const scratch = join(ws, '.scratch', ticket);
  if (existsSync(scratch)) {
    if (kept) lines.push(`kept ${relative(ws, scratch)}: a worktree for ${ticket} is still there`);
    else {
      rmSync(scratch, { recursive: true });
      lines.push(`removed ${relative(ws, scratch)}`);
    }
  }
  return lines.length ? lines : [`nothing to clean up for ${ticket}`];
}
