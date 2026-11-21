import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/config.ts';
import { renderDash } from '../src/dash.ts';
import { deskData, prBadges, prTone, snapshotAge } from '../src/desk.ts';
import { saveSnapshot, type PrState } from '../src/prs.ts';
import { tmpEnv } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const pr = (number: number, over: Partial<PrState> = {}): PrState => ({
  id: `o/api#${number}`,
  repo: 'api',
  number,
  title: `Title ${number}`,
  url: `https://example.test/${number}`,
  role: 'author',
  draft: false,
  base: 'develop',
  ci: 'pass',
  failing: [],
  conflicts: false,
  review: '',
  unresolved: 0,
  updatedAt: '',
  staleDays: 0,
  tickets: ['ACME-1'],
  needs: [],
  ...over,
});

function envWithPrs() {
  const env = tmpEnv();
  saveSnapshot(env.cfg, {
    generated: '2026-10-19T08:30:00Z',
    changes: [],
    errors: [],
    prs: [
      pr(1, { ci: 'fail', needs: ['Fix failing CI: build'] }),
      pr(2, { review: 'APPROVED' }),
      pr(3, { draft: true, staleDays: 5 }),
      pr(9, { role: 'reviewer' }),
    ],
  });
  return env;
}

test('a PR is judged once: tone, badges and the age of the data', () => {
  const tones = [
    pr(1, { ci: 'fail' }),
    pr(2, { conflicts: true }),
    pr(3, { needs: ['x'] }),
    pr(4, { review: 'APPROVED' }),
    pr(5),
  ];
  assert.deepEqual(tones.map(prTone), ['bad', 'bad', 'warn', 'good', 'idle']);
  const busy = pr(6, { draft: true, conflicts: true, unresolved: 2, review: 'CHANGES_REQUESTED', staleDays: 4 });
  assert.deepEqual(
    prBadges(busy).map((badge) => badge.text),
    ['draft', 'CI passing', 'changes requested', 'merge conflict', '2 unresolved', 'quiet 4d'],
  );
  assert.deepEqual(prBadges(pr(7, { ci: 'none' })), [{ text: 'no review yet', tone: 'idle' }]);
  assert.deepEqual(snapshotAge('2026-10-19T08:30:00Z', NOW), { text: 'PR data 30 min ago', stale: false });
  assert.deepEqual(snapshotAge('2026-10-19T03:00:00Z', NOW), { text: 'PR data 6 h ago', stale: true });
  assert.equal(snapshotAge('', NOW).stale, true);
});

test('desk data carries the summary and each PR already judged', () => {
  const { cfg } = envWithPrs();
  const desk = deskData(cfg, NOW);
  assert.deepEqual(desk.summary, { all: 3, action: 1, drafts: 1, approved: 1, failing: 1, reviews: 1 });
  assert.equal(desk.snapshot.text, 'PR data 30 min ago');
  assert.deepEqual(
    desk.groups[0]!.prs.map((p) => p.tone),
    ['bad', 'good', 'idle'],
  );
  assert.equal(desk.reviews[0]!.badges[0]!.text, 'CI passing');
});

test('pai dash puts what needs you first, as plain text when not in a terminal', () => {
  const { cfg, cfgPath } = envWithPrs();
  const text = renderDash(cfg, NOW).join('\n');
  assert.doesNotMatch(text, /\u001b\[/, 'no colour codes outside a terminal');
  assert.match(text, /✗ 1 broken {3}● 1 need action {3}✓ 1 approved {3}● 1 to review/);
  assert.ok(text.indexOf('NEEDS YOU 1') < text.indexOf('REVIEW REQUESTS 1'));
  assert.ok(text.indexOf('REVIEW REQUESTS 1') < text.indexOf('OPEN, NOTHING TO DO 2'));
  assert.match(text, /✗ api#1 {2}Title 1\n {5}CI failing · no review yet\n {5}→ Fix failing CI: build/);
  assert.match(text, /ROUTINES\n ○ brief {3}has not run yet/);

  const cli = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'cli.ts'), 'dash'], {
      encoding: 'utf8',
      env: { ...process.env, PAI_CONFIG: cfgPath, ...env },
    }).stdout;
  assert.match(cli({ FORCE_COLOR: '1' }), /\u001b\[31m✗\u001b\[39m/, 'a red cross in a terminal');
  assert.doesNotMatch(cli({ FORCE_COLOR: '0', NO_COLOR: '1' }), /\u001b\[/);
});
