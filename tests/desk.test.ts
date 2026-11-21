import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deskData, previousWorkingDay, standupFacts, standupPrompt } from '../src/desk.ts';
import { saveSnapshot, type PrState } from '../src/prs.ts';
import { record } from '../src/notes.ts';
import { addEvents } from '../src/timeline.ts';
import { writeVaultFile } from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

const pr = (n: number, role: PrState['role'], tickets: string[], needs: string[]): PrState => ({
  id: `o/api#${n}`,
  repo: 'api',
  number: n,
  title: `T${n}`,
  url: `u${n}`,
  role,
  draft: false,
  base: 'develop',
  ci: 'pass',
  failing: [],
  conflicts: false,
  review: '',
  unresolved: 0,
  updatedAt: '2026-10-19T00:00:00Z',
  staleDays: 0,
  tickets,
  needs,
});

test('previous working day skips weekends and days off', () => {
  const { cfg } = tmpEnv((raw) => {
    raw.standup = { days_off: ['2026-10-16'] };
  });
  assert.equal(
    previousWorkingDay(cfg, new Date('2026-10-19T09:00:00Z')),
    '2026-10-15',
    'Monday after a Friday off goes to Thursday',
  );
  assert.equal(previousWorkingDay(cfg, new Date('2026-10-21T09:00:00Z')), '2026-10-20');
});

test('desk groups my PRs by ticket, needs-action first, with reviews, tickets and sessions', () => {
  const { cfg } = tmpEnv();
  saveSnapshot(cfg, {
    generated: '2026-10-19T00:00:00Z',
    changes: [],
    errors: [],
    prs: [
      pr(1, 'author', ['ACME-1'], []),
      pr(2, 'author', ['ACME-2'], ['Fix failing CI: build']),
      pr(3, 'author', [], []),
      pr(4, 'reviewer', ['ACME-9'], ['Review requested on api#4']),
    ],
  });
  writeVaultFile(
    cfg.paths.vault,
    '09-Tracker/ACME-2.md',
    '---\ntype: ticket\nkey: ACME-2\nstatus: In Progress\nassignee: "[[Jane Doe]]"\nsummary: Two\n---\n# x\n',
  );
  writeVaultFile(
    cfg.paths.vault,
    '09-Tracker/ACME-3.md',
    '---\ntype: ticket\nkey: ACME-3\nstatus: Done\nassignee: "[[Jane Doe]]"\n---\n# x\n',
  );
  addEvents(cfg, [
    {
      ts: '2026-10-18 10:00',
      type: 'session',
      title: 'api (feature/ACME-2-x): fix it [3 prompts]',
      links: ['ACME-2'],
      src: 'session',
      id: 'session-abc',
    },
  ]);
  const d = deskData(cfg, new Date('2026-10-19T00:00:00Z'));
  assert.equal(d.groups[0]!.ticket, 'ACME-2');
  assert.deepEqual(d.groups.map((g) => g.ticket).sort(), ['ACME-1', 'ACME-2', 'No ticket']);
  assert.equal(d.reviews.length, 1);
  assert.deepEqual(
    d.tickets.map((t) => t.key),
    ['ACME-2'],
  );
  assert.equal(d.sessions['ACME-2'], 'abc');
  assert.equal(d.sessions['feature/ACME-2-x'], 'abc');
});

test('standup facts keep only my work since the previous working day', () => {
  const { cfg } = tmpEnv();
  writeVaultFile(cfg.paths.vault, '11-PRs/PR-api-7.md', '---\ntype: pr\nauthor: "[[Jane Doe]]"\n---\n# x\n');
  writeVaultFile(cfg.paths.vault, '11-PRs/PR-api-8.md', '---\ntype: pr\nauthor: "[[Bob Roe]]"\n---\n# x\n');
  addEvents(cfg, [
    {
      ts: '2026-10-16 11:00',
      type: 'commits',
      title: 'api feature/ACME-7: 2 commits: Fix x',
      links: ['api', 'ACME-7'],
      src: 'git',
      id: 'c1',
    },
    {
      ts: '2026-10-16 12:00',
      type: 'pr-merged',
      title: 'api#7 ACME-7: Fix x',
      links: ['PR-api-7', 'ACME-7'],
      src: 'github',
      id: 'm7',
    },
    {
      ts: '2026-10-16 12:30',
      type: 'pr-merged',
      title: 'api#8 ACME-8: Other',
      links: ['PR-api-8', 'ACME-8'],
      src: 'github',
      id: 'm8',
    },
    { ts: '2026-10-14 09:00', type: 'commits', title: 'api old: 1 commit: Old', links: ['api'], src: 'git', id: 'c0' },
  ]);
  const f = standupFacts(cfg, new Date('2026-10-19T09:00:00Z'));
  assert.equal(f.since, '2026-10-16');
  assert.deepEqual(
    f.groups.map((g) => g.key),
    ['ACME-7'],
  );
  assert.equal(f.groups[0]!.facts.length, 2);
  void record;
});

test('standup prompt carries the voice card and only the facts', () => {
  const { cfg } = tmpEnv();
  const p = standupPrompt(cfg, '# P\n## Voice card\n1. Short.\n## People\nx', {
    since: '2026-10-16',
    groups: [{ key: 'ACME-7', facts: ['10-16 commits: Fix x'] }],
  });
  assert.match(p, /## Voice card\n1\. Short\./);
  assert.doesNotMatch(p, /## People/);
  assert.match(p, /ACME-7\n- 10-16 commits: Fix x/);
  assert.doesNotMatch(p, /[\u2014\u2013]/);
});
