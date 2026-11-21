import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { finishTicket } from '../src/done.ts';
import { computeStats, formatStats } from '../src/stats.ts';
import { tmpEnv } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });

test('pai done removes a clean, pushed worktree and its scratch folder, and keeps unsaved work', () => {
  const { cfg } = tmpEnv();
  const ws = cfg.paths.workspace;
  const api = join(ws, 'api');
  const origin = join(ws, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(api, 'init', '-q', '-b', 'develop');
  writeFileSync(join(api, 'a.txt'), 'a');
  git(api, 'add', '.');
  git(api, 'commit', '-q', '-m', 'init');
  git(api, 'remote', 'add', 'origin', origin);
  git(api, 'push', '-q', 'origin', 'develop');
  const worktree = (ticket: string) => join(ws, `api-wt-${ticket}`);
  for (const ticket of ['ACME-1', 'ACME-2', 'ACME-3']) {
    git(api, 'worktree', 'add', '-q', '-b', `feature/${ticket}`, worktree(ticket));
    mkdirSync(join(ws, '.scratch', ticket), { recursive: true });
  }
  writeFileSync(join(worktree('ACME-2'), 'a.txt'), 'changed');
  writeFileSync(join(worktree('ACME-3'), 'b.txt'), 'b');
  git(worktree('ACME-3'), 'add', '.');
  git(worktree('ACME-3'), 'commit', '-q', '-m', 'local only');

  assert.deepEqual(finishTicket(cfg, 'ACME-1'), ['removed worktree api-wt-ACME-1', 'removed .scratch/ACME-1']);
  assert.equal(existsSync(worktree('ACME-1')), false);
  assert.deepEqual(finishTicket(cfg, 'ACME-2'), [
    'kept api-wt-ACME-2: it has uncommitted changes',
    'kept .scratch/ACME-2: a worktree for ACME-2 is still there',
  ]);
  assert.match(finishTicket(cfg, 'ACME-3')[0]!, /^kept api-wt-ACME-3: 1 commit is on no remote$/);
  assert.equal(existsSync(join(ws, '.scratch', 'ACME-3')), true);
  assert.deepEqual(finishTicket(cfg, 'ACME-9'), ['nothing to clean up for ACME-9']);
  assert.throws(() => finishTicket(cfg, '../api'), /not a ticket/);
  assert.throws(() => finishTicket(cfg, '..'), /not a ticket/);
});

test('stats name the gate categories behind approvals and denials', () => {
  const { cfg } = tmpEnv();
  mkdirSync(cfg.paths.logs_dir, { recursive: true });
  const entry = (decision: string, cats: string[]) => JSON.stringify({ ts: '2026-10-15T10:00:00Z', decision, cats });
  writeFileSync(
    join(cfg.paths.logs_dir, 'hooks.jsonl'),
    [
      entry('approval', ['git_commit']),
      entry('approval', ['git_commit', 'git_push']),
      entry('deny', ['secret_read']),
      entry('allow', ['git_commit']),
    ].join('\n'),
  );
  const text = formatStats(computeStats(cfg, 7, Date.parse('2026-10-16T00:00:00Z')));
  assert.match(text, /Most asked: git_commit 2, git_push 1/);
  assert.match(text, /Most denied: secret_read 1/);
});
