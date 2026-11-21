import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncCommits } from '../src/sync/commits.ts';
import { readEvents } from '../src/timeline.ts';
import { writeVaultFile } from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

test('commit sync assigns branches, links PRs, marks merged, and is idempotent', () => {
  const env = tmpEnv((raw) => {
    raw.people.aliases['jane@acme.com'] = 'Jane Doe';
    raw.github.since = '2020-01-01';
  });
  const { cfg, root } = env;
  const g = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'jane@acme.com',
        GIT_AUTHOR_NAME: 'Jane',
        GIT_COMMITTER_EMAIL: 'jane@acme.com',
        GIT_COMMITTER_NAME: 'Jane',
      },
    });
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', bare]);
  const repo = join(cfg.paths.workspace, 'api');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'develop');
  g(repo, 'remote', 'add', 'origin', bare);
  const commit = (msg: string) => {
    writeFileSync(join(repo, 'f.txt'), msg);
    g(repo, 'add', 'f.txt');
    g(repo, 'commit', '-q', '-m', msg);
  };
  commit('ACME-1: Base work');
  g(repo, 'push', '-q', 'origin', 'develop');
  g(repo, 'checkout', '-q', '-b', 'feature/orf');
  commit('Add ORF grid');
  commit('Fix ORF timer');
  g(repo, 'push', '-q', 'origin', 'feature/orf');
  g(repo, 'checkout', '-q', 'develop');
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'Someone else'], {
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'x@y.com',
      GIT_AUTHOR_NAME: 'X',
      GIT_COMMITTER_EMAIL: 'x@y.com',
      GIT_COMMITTER_NAME: 'X',
    },
  });
  g(repo, 'push', '-q', 'origin', 'develop');
  g(repo, 'fetch', '-q', 'origin');
  writeVaultFile(cfg.paths.vault, '11-PRs/PR-api-9.md', '---\ntype: pr\nbranch: feature/orf\n---\n# x\n');
  const rep = syncCommits(cfg);
  assert.deepEqual(rep.errors, []);
  const note = readFileSync(join(cfg.paths.vault, '95-Sources/Git/api.md'), 'utf8');
  assert.match(note, /3 commits by Jane Doe/);
  assert.match(note, /\| `feature\/orf` \| 2 \| .* \| 0\/2 \| \[\[PR-api-9\]\] \|/);
  assert.match(note, /\| `develop` \| 1 \| .* \| 1\/1 \| none \|/);
  assert.doesNotMatch(note, /Someone else/);
  const evs = readEvents(cfg, { sinceDays: 99999, type: 'commits' });
  assert.ok(
    evs.some(
      (e) => /api feature\/orf: 2 commits: Add ORF grid; Fix ORF timer/.test(e.title) && e.links.includes('PR-api-9'),
    ),
  );
  const again = syncCommits(cfg);
  assert.equal(again.notes + again.events, 0);
});
