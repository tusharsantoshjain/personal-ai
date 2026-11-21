import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatLooseEnds, looseEnds } from '../src/loose.ts';
import { tmpEnv } from './helpers.ts';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...a], { env: ENV, stdio: 'pipe' }).toString();

test('loose ends: unpushed branches, uncommitted checkouts and recent drafts; local-only repos are skipped', () => {
  const { cfg } = tmpEnv();
  const ws = cfg.paths.workspace;
  const remote = join(ws, '..', 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const repo = join(ws, 'org', 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), '1');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-qc', 'feature/ACME-1');
  writeFileSync(join(repo, 'a.txt'), '2');
  git(repo, 'commit', '-qam', 'two');
  writeFileSync(join(repo, 'a.txt'), '3');
  const local = join(ws, 'notes');
  mkdirSync(local);
  git(local, 'init', '-q');
  writeFileSync(join(local, 'n.md'), 'x');
  git(local, 'add', '.');
  git(local, 'commit', '-qm', 'local only');
  mkdirSync(join(ws, '.scratch', 'ACME-1'), { recursive: true });
  writeFileSync(join(ws, '.scratch', 'ACME-1', 'signoff-comment.md'), 'x');
  writeFileSync(join(ws, '.scratch', 'ACME-1', 'build.log'), 'x');

  const ends = looseEnds(cfg);
  assert.deepEqual(
    ends.map((e) => [e.kind, e.where, e.detail]),
    [
      ['unpushed', 'app feature/ACME-1', '1 commit on no remote'],
      ['uncommitted', 'org/app', '1 changed file (feature/ACME-1)'],
      ['draft', '.scratch/ACME-1/signoff-comment.md', 'ACME-1 draft, not known to be sent'],
    ],
  );
  assert.equal(formatLooseEnds(ends)[0], '- Not pushed:');
  assert.deepEqual(
    looseEnds(cfg, Date.now() + 30 * 86_400_000).map((e) => e.kind),
    [],
    'old work drops off',
  );
});
