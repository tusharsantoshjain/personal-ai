import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checklistRun, releaseCheck, releaseNotes, renderReleaseNotes, writeReleaseNote } from '../src/release.ts';
import { writeVaultFile } from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

const prNote = (n: number, ticket: string | null, merged: string, base = 'develop', status = 'merged') =>
  `---\ntype: pr\nnumber: ${n}\ntitle: "T${n} \\u2014 x"\nstatus: ${status}\nbase: ${base}\nmerged: ${merged}\nauthor: "[[Jane Doe]]"\ntickets: ${ticket ? `["[[${ticket}]]"]` : '[]'}\n---\n# x\n`;

test('release notes group merged PRs by ticket and check fix versions', () => {
  const { cfg } = tmpEnv();
  const v = cfg.paths.vault;
  writeVaultFile(v, '11-PRs/PR-api-1.md', prNote(1, 'ACME-1', '2026-10-10'));
  writeVaultFile(v, '11-PRs/PR-api-2.md', prNote(2, 'ACME-2', '2026-10-12'));
  writeVaultFile(v, '11-PRs/PR-api-3.md', prNote(3, null, '2026-10-13'));
  writeVaultFile(v, '11-PRs/PR-api-4.md', prNote(4, 'ACME-1', '2026-09-01'));
  writeVaultFile(v, '11-PRs/PR-api-5.md', prNote(5, 'ACME-5', '2026-10-14', 'master'));
  writeVaultFile(v, '11-PRs/PR-api-6.md', prNote(6, 'ACME-6', '', 'develop', 'open'));
  writeVaultFile(v, '09-Tracker/ACME-1.md', '---\ntype: ticket\nfix_versions: ["1.4.0"]\n---\n# x\n');
  writeVaultFile(v, '09-Tracker/ACME-2.md', '---\ntype: ticket\nfix_versions: []\n---\n# x\n');
  const n = releaseNotes(cfg, 'api', 'develop', '2026-10-01', '1.4.0');
  assert.deepEqual(
    n.byTicket.map((g) => g.ticket),
    ['ACME-1', 'ACME-2'],
  );
  assert.deepEqual(
    n.noTicket.map((p) => p.number),
    [3],
  );
  assert.deepEqual(n.fixVersionIssues, ['ACME-2: no fix version']);
  const md = renderReleaseNotes(n, '1.4.0');
  assert.match(md, /### \[\[ACME-1\]\] \(fix 1\.4\.0\)\n- \[\[PR-api-1\]\] T1 - x/);
  assert.doesNotMatch(md, /[—–]/);
  const rel = writeReleaseNote(cfg, n, '2026-10-19', '1.4.0');
  assert.equal(rel, '03-Projects/Releases/api 1.4.0.md');
  assert.match(readFileSync(join(v, rel), 'utf8'), /type: release/);
});

test('release check lists commits to downmerge and PRs on the wrong base', () => {
  const { cfg, root } = tmpEnv();
  const g = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'J',
        GIT_AUTHOR_EMAIL: 'j@x',
        GIT_COMMITTER_NAME: 'J',
        GIT_COMMITTER_EMAIL: 'j@x',
      },
    });
  const bare = join(root, 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', bare]);
  const dir = join(root, 'repo');
  mkdirSync(dir);
  g(dir, 'init', '-q', '-b', 'develop');
  g(dir, 'remote', 'add', 'origin', bare);
  const commit = (m: string, f = 'a.txt') => {
    writeFileSync(join(dir, f), m);
    g(dir, 'add', f);
    g(dir, 'commit', '-q', '-m', m);
  };
  commit('base');
  g(dir, 'push', '-q', 'origin', 'develop');
  g(dir, 'checkout', '-q', '-b', 'release/1.4');
  commit('ACME-9: Hotfix on release', 'b.txt');
  g(dir, 'push', '-q', 'origin', 'release/1.4');
  g(dir, 'fetch', '-q', 'origin');
  const c = releaseCheck(cfg, dir, 'release/1.4', 'develop', [
    { number: 7, title: 'Fix crash', baseRefName: 'develop', headRefName: 'hotfix/crash' },
    { number: 8, title: 'New grid', baseRefName: 'release/1.4', headRefName: 'feature/ACME-8-grid' },
    { number: 9, title: 'Normal work', baseRefName: 'develop', headRefName: 'feature/ACME-10' },
  ]);
  assert.equal(c.missingDownmerge.length, 1);
  assert.match(c.missingDownmerge[0]!, /ACME-9: Hotfix on release/);
  assert.deepEqual(
    c.wrongBase.map((x) => x.split(' ')[0]),
    ['#7', '#8'],
  );
});

test('checklist run copies a markdown checklist without values, once', () => {
  const { cfg, root } = tmpEnv();
  const f = join(root, 'CHECK.md');
  writeFileSync(f, '# Deploy — Prod\n\n## 1. `svc`\n### SSM\n- [ ] \u{1F195} `feature.url`\n- [ ] `db.endpoint`\n');
  const run = checklistRun(cfg, f, 'webapp-2026-10-20');
  const text = readFileSync(join(cfg.paths.vault, cfg.vault.runs_folder, `${run}.md`), 'utf8');
  assert.match(text, /type: run/);
  assert.match(text, /## Checklist[\s\S]*- \[ \] \(new\) `feature\.url`/);
  assert.doesNotMatch(text, /[—\u{1F195}]/u);
  checklistRun(cfg, f, 'webapp-2026-10-20');
  assert.equal(
    (readFileSync(join(cfg.paths.vault, cfg.vault.runs_folder, `${run}.md`), 'utf8').match(/## Checklist/g) ?? [])
      .length,
    1,
  );
});
