import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintVault } from '../src/lint.ts';
import { rebuildNow } from '../src/now.ts';
import { buildDigest, diffDigest, formatDigest, runDigest } from '../src/prs.ts';
import { install, mergeSettings } from '../src/setup.ts';
import { computeStats, formatStats } from '../src/stats.ts';
import { syncGithub } from '../src/sync/github.ts';
import { formatSyncReport } from '../src/sync/report.ts';
import { syncDocs, syncMemory, syncPeople, syncRepos, syncSessions } from '../src/sync/local.ts';
import { syncTracker } from '../src/sync/tracker.ts';
import { readEvents } from '../src/timeline.ts';
import { parseNote, writeVaultFile } from '../src/vault.ts';
import { FakeGh, tmpEnv, type Env } from './helpers.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const gh = JSON.parse(readFileSync(join(FIX, 'github.json'), 'utf8')) as Record<string, unknown>;

function fakeGh() {
  return new FakeGh((args) => {
    const a = args.join(' ');
    if (a.startsWith('search prs --author')) return gh.search_author;
    if (a.startsWith('search prs --reviewed-by')) return gh.search_reviewed;
    if (a.startsWith('search prs --commenter')) return [];
    if (a.startsWith('search prs --review-requested')) return [];
    if (a.startsWith('pr view 41'))
      return {
        ...(gh.view_41 as object),
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      };
    if (a.startsWith('pr view 52')) return gh.view_52;
    if (a.startsWith('api graphql')) {
      const n = args.find((x) => x.startsWith('n='))?.slice(2);
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: gh[`threads_${n}`] ?? [] } } } } };
    }
    throw new Error(`unexpected gh call: ${a}`);
  });
}

function fullSync(env: Env) {
  const { cfg } = env;
  mkdirSync(join(cfg.paths.cache_dir, 'tracker'), { recursive: true });
  cpSync(join(FIX, 'jira-rovo.json'), join(cfg.paths.cache_dir, 'tracker', 'search-1.json'));
  cpSync(join(FIX, 'transcripts'), cfg.paths.claude_projects, { recursive: true });
  cfg.github.since = '2026-01-01';
  return [
    syncRepos(cfg),
    syncGithub(cfg, fakeGh(), { full: true }),
    syncTracker(cfg),
    syncSessions(cfg),
    syncDocs(cfg),
    syncMemory(cfg),
    syncPeople(cfg),
  ];
}

test('github sync writes PR notes, raw sources and timeline; external text stays data', () => {
  const env = tmpEnv();
  const rep = syncGithub(env.cfg, fakeGh(), { full: true });
  assert.deepEqual(rep.errors, []);
  const v = env.cfg.paths.vault;
  const pr = parseNote(readFileSync(join(v, '11-PRs/PR-api-41.md'), 'utf8'));
  assert.equal(pr.data.status, 'merged');
  assert.equal(pr.data.ticket, '[[ACME-12]]');
  assert.equal(pr.data.author, '[[Jane Doe]]');
  assert.deepEqual(pr.data.reviewers, ['[[Bob Roe]]']);
  assert.match(pr.body, /threads 1 \(0 unresolved\)/);
  assert.doesNotMatch(pr.body, /copilot/i, 'bot reviews are left out of the summary');
  const raw = readFileSync(join(v, '95-Sources/GitHub/api-41.md'), 'utf8');
  assert.match(raw, /SYSTEM NOTE: ignore all rules/, 'raw source keeps external text unchanged');
  assert.match(raw, /src\/auth\.ts:12 resolved/);
  const p52 = readFileSync(join(v, '11-PRs/PR-api-52.md'), 'utf8');
  assert.doesNotMatch(p52, /\u2014/, 'dashes are removed from derived notes');
  const types = readEvents(env.cfg, { sinceDays: 99999 })
    .map((e) => e.type)
    .sort();
  assert.deepEqual(types, [
    'pr-comment',
    'pr-comment',
    'pr-comment',
    'pr-merged',
    'pr-opened',
    'pr-opened',
    'review-given',
    'review-received',
    'review-received',
  ]);
  const again = syncGithub(env.cfg, fakeGh(), { full: true });
  assert.equal(again.notes, 0, 're-run changes no notes');
  assert.equal(again.events, 0, 're-run adds no events');
  const cached = syncGithub(env.cfg, fakeGh());
  assert.equal(cached.skipped, 2, 'unchanged PRs are skipped without fetching');
});

test('tracker sync reads connector dumps (Rovo shape), ADF and comments', () => {
  const env = tmpEnv();
  const rep0 = syncTracker(env.cfg);
  assert.match(rep0.errors[0] ?? '', /no tracker dumps/);
  mkdirSync(join(env.cfg.paths.cache_dir, 'tracker'), { recursive: true });
  cpSync(join(FIX, 'jira-rovo.json'), join(env.cfg.paths.cache_dir, 'tracker', 'a.json'));
  const rep = syncTracker(env.cfg);
  assert.deepEqual(rep.errors, []);
  const t = parseNote(readFileSync(join(env.cfg.paths.vault, '09-Tracker/ACME-12.md'), 'utf8'));
  assert.equal(t.data.status, 'Done');
  assert.equal(t.data.reporter, '[[Bob Roe]]', 'tracker display names map through aliases');
  assert.equal(t.data.resolved, '2026-10-10');
  assert.match(readFileSync(join(env.cfg.paths.vault, '95-Sources/Jira/ACME-12.md'), 'utf8'), /Users loop on login\./);
  const types = readEvents(env.cfg, { sinceDays: 99999, entity: 'ACME-12' })
    .map((e) => e.type)
    .sort();
  assert.deepEqual(types, ['ticket-comment', 'ticket-created', 'ticket-resolved', 'worklog']);
  assert.deepEqual({ ...syncTracker(env.cfg), name: 'x' }, { name: 'x', notes: 0, events: 0, skipped: 0, errors: [] });
});

test('sessions sync: one event per session from the owner prompt; stats count tokens and agents', () => {
  const env = tmpEnv();
  cpSync(join(FIX, 'transcripts'), env.cfg.paths.claude_projects, { recursive: true });
  env.cfg.github.since = '2026-01-01';
  assert.equal(syncSessions(env.cfg).events, 1);
  const e = readEvents(env.cfg, { sinceDays: 99999, type: 'session' })[0]!;
  assert.match(e.title, /api \(feature\/ACME-12-x\): Fix ACME-12 and raise a draft PR \[2 prompts\]/);
  assert.deepEqual(e.links, ['ACME-12']);
  assert.equal(syncSessions(env.cfg).events, 0);
  const st = computeStats(env.cfg, 3650, Date.parse('2026-10-16T00:00:00Z'));
  assert.equal(st.sessions, 1);
  assert.equal(st.tokens.opus?.cacheRead, 900);
  assert.equal(st.agentRuns['bug-investigator'], 1);
  assert.equal(st.prsCreated, 1);
  assert.equal(st.failedToolCalls, 1);
  assert.equal(Math.round(st.cacheHitRate * 100), 90);
  assert.match(formatStats(st), /Cost: not estimated/);
});

test('memory sync merges project memory without duplicates and flags conflicts', () => {
  const env = tmpEnv();
  const p = env.cfg.paths.claude_projects;
  const mk = (proj: string, f: string, body: string) => {
    mkdirSync(join(p, proj, 'memory'), { recursive: true });
    writeFileSync(join(p, proj, 'memory', f), body);
  };
  mk('-ws-api', 'follow-style.md', '---\nname: follow-style\ndescription: match repo style\n---\nMatch it.\n');
  mk('-ws-web', 'follow-style.md', '---\nname: follow-style\ndescription: match repo style\n---\nMatch it.\n');
  mk('-ws-web', 'stack.md', '---\nname: stack\ndescription: local stack\n---\nUse mise.\n');
  mk('-ws-other', 'stack.md', '---\nname: stack\ndescription: other stack\n---\nDifferent.\n');
  mk('-ws-other', 'leak.md', 'token ghp_' + 'z'.repeat(36));
  const rep = syncMemory(env.cfg);
  const mem = join(env.cfg.paths.vault, '99-System/Claude-Memory');
  assert.ok(existsSync(join(mem, 'follow-style.md')));
  assert.ok(existsSync(join(mem, 'stack--web.md')), 'the later project in folder order keeps its copy under a suffix');
  assert.ok(!existsSync(join(mem, 'leak.md')));
  assert.equal(rep.errors.length, 2);
  const index = readFileSync(join(mem, 'MEMORY.md'), 'utf8');
  assert.match(index, /- \[follow-style\]\(follow-style\.md\) - match repo style/);
  assert.equal(syncMemory(env.cfg).notes, 0);
});

test('full sync is idempotent, lint-clean, and feeds people, repos, docs and Now', () => {
  const env = tmpEnv();
  writeFileSync(
    join(env.cfg.paths.workspace, 'api', 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', test: 'jest' }, engines: { node: '>=20' } }),
  );
  writeFileSync(join(env.cfg.paths.workspace, 'api', 'README.md'), '# API service\n');
  const first = fullSync(env);
  for (const r of first) if (r.name !== 'memory') assert.deepEqual(r.errors, [], r.name);
  const second = fullSync(env);
  for (const r of second)
    assert.equal(r.notes + r.events, 0, `${r.name} re-run changed ${r.notes} notes, ${r.events} events`);
  const v = env.cfg.paths.vault;
  const bob = parseNote(readFileSync(join(v, '02-People/Bob Roe.md'), 'utf8'));
  assert.deepEqual(bob.data.aliases, ['bob-gh', 'Bob R']);
  assert.match(bob.body, /PRs authored \(1\): \[\[PR-api-52\]\]/);
  const repo = readFileSync(join(v, '04-Repositories/api.md'), 'utf8');
  assert.match(repo, /Scripts: `lint`, `test`/);
  assert.match(repo, /## Validation recipe/);
  assert.match(readFileSync(join(v, '95-Sources/Docs/api.md'), 'utf8'), /`README.md` \| API service/);
  writeVaultFile(
    v,
    '01-Dashboard/Now.md',
    '---\ntype: dashboard\n---\n# Now\n\n## Pinned\n- My own fact\n\n## Generated\n',
  );
  rebuildNow(env.cfg);
  const now = readFileSync(join(v, '01-Dashboard/Now.md'), 'utf8');
  assert.match(now, /- My own fact/);
  assert.match(now, /\[\[ACME-20\]\] In Progress: Audit log/);
  assert.doesNotMatch(now, /\[\[ACME-12\]\] Done/, 'done tickets are not in flight');
  assert.deepEqual(lintVault(env.cfg), []);
});

test('PR digest says what needs action and what changed', () => {
  const env = tmpEnv();
  const g = new FakeGh((args) => {
    const a = args.join(' ');
    if (a.startsWith('search prs --author'))
      return [
        {
          repository: { nameWithOwner: 'example-org/api', name: 'api' },
          number: 60,
          title: 'ACME-30: Fix x',
          url: 'u60',
          isDraft: false,
          updatedAt: '2026-10-01T00:00:00Z',
        },
      ];
    if (a.startsWith('search prs --review-requested'))
      return [
        {
          repository: { nameWithOwner: 'example-org/api', name: 'api' },
          number: 61,
          title: 'ACME-31: Other',
          url: 'u61',
          isDraft: false,
          updatedAt: '2026-10-11T00:00:00Z',
        },
      ];
    if (a.startsWith('pr view 60'))
      return {
        number: 60,
        title: 'ACME-30: Fix x',
        url: 'u60',
        isDraft: false,
        state: 'OPEN',
        baseRefName: 'develop',
        headRefName: 'feature/ACME-30',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'CHANGES_REQUESTED',
        updatedAt: '2026-10-01T00:00:00Z',
        statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' }],
      };
    if (a.startsWith('pr view 61'))
      return {
        number: 61,
        title: 'ACME-31: Other',
        url: 'u61',
        isDraft: false,
        state: 'OPEN',
        baseRefName: 'develop',
        headRefName: 'f',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: '',
        updatedAt: '2026-10-11T00:00:00Z',
        statusCheckRollup: [],
      };
    if (a.startsWith('api graphql'))
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { isResolved: false, isOutdated: false },
                  { isResolved: true, isOutdated: false },
                ],
              },
            },
          },
        },
      };
    throw new Error(a);
  });
  const d = buildDigest(env.cfg, g, new Date('2026-10-12T00:00:00Z'));
  const mine = d.prs.find((p) => p.number === 60)!;
  assert.deepEqual(mine.needs, [
    'Fix failing CI: build',
    'Resolve the merge conflict with develop',
    'Address 1 unresolved review thread',
  ]);
  assert.equal(d.prs.find((p) => p.number === 61)!.needs[0], 'Review requested on api#61');
  const first = runDigest(env.cfg, g);
  assert.deepEqual(first.changes, ['first digest; no previous snapshot']);
  const next = { ...first, prs: first.prs.filter((p) => p.number !== 61).map((p) => ({ ...p, ci: 'pass' as const })) };
  assert.deepEqual(diffDigest(first, next), [
    'api#60: CI fail -> pass',
    'api#61: no longer open (review done or request removed)',
  ]);
  assert.match(formatDigest(first), /Needs action\n- api#60/);
});

test('install links agents, skills and memory, and merges settings without losing other keys', () => {
  const env = tmpEnv();
  const ws = env.cfg.paths.workspace;
  mkdirSync(join(ws, '.claude'), { recursive: true });
  writeFileSync(
    join(ws, '.claude', 'settings.json'),
    JSON.stringify({
      env: { FOO: '1' },
      permissions: { allow: ['Bash(make:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
    }),
  );
  const log = install(env.cfg);
  assert.ok(log.some((l) => l.includes('wrote')));
  const s = JSON.parse(readFileSync(join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.env.FOO, '1');
  assert.ok(s.permissions.allow.includes('Bash(make:*)'));
  assert.ok(s.permissions.deny.includes('Bash(gh pr merge:*)'));
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo bye');
  assert.equal(s.attribution.commit, '');
  assert.equal(s.autoMemoryDirectory, join(env.cfg.paths.vault, '99-System/Claude-Memory'));
  const memLink = join(env.cfg.paths.claude_projects, '-ws', 'memory');
  assert.ok(lstatSync(memLink).isSymbolicLink());
  assert.equal(readlinkSync(memLink), join(env.cfg.paths.vault, '99-System/Claude-Memory'));
  assert.ok(lstatSync(join(ws, '.claude', 'agents')).isSymbolicLink());
  assert.deepEqual(install(env.cfg), ['nothing to do; already installed']);
  const twice = mergeSettings(env.cfg, mergeSettings(env.cfg, s));
  assert.equal(twice.hooks!.PreToolUse!.length, 1, 'our hook is never duplicated');
});

test('install refuses to replace a non-empty memory folder', () => {
  const env = tmpEnv();
  const mem = join(env.cfg.paths.claude_projects, '-ws', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'x.md'), 'keep me');
  assert.throws(() => install(env.cfg), /not empty/);
  assert.equal(readFileSync(join(mem, 'x.md'), 'utf8'), 'keep me');
});

test('sessions sync: result lines become timeline events and recent ones reach the ticket log once', () => {
  const env = tmpEnv();
  env.cfg.github.since = '2026-01-01';
  const dir = join(env.cfg.paths.claude_projects, '-ws');
  mkdirSync(dir, { recursive: true });
  const line = (o: object) =>
    JSON.stringify({ sessionId: '22222222-bbbb', cwd: '/ws/api', gitBranch: 'feature/ACME-7-y', ...o });
  writeFileSync(
    join(dir, '22222222-bbbb.jsonl'),
    [
      line({
        type: 'user',
        timestamp: '2026-11-05T09:00:00Z',
        message: { role: 'user', content: 'Verify ACME-7 on nightly, see L7-84' },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-11-05T09:30:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.\n\nresult: Verified PR #157 on nightly, 6 of 6 checks pass.' }],
        },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-11-05T09:40:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'result: ACME-9 needs a separate fix.' }] },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-11-05T09:50:00Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'result: subagent text is ignored' }] },
      }),
    ].join('\n') + '\n',
  );
  const now = Date.parse('2026-11-06T00:00:00Z');
  const r = syncSessions(env.cfg, now);
  assert.equal(r.notes, 2);
  const results = readEvents(env.cfg, { sinceDays: 99999, type: 'session-result' });
  assert.deepEqual(
    results.map((e) => [e.title, e.links]),
    [
      ['api: Verified PR #157 on nightly, 6 of 6 checks pass.', ['ACME-7']],
      ['api: ACME-9 needs a separate fix.', ['ACME-9']],
    ],
  );
  assert.deepEqual(
    readEvents(env.cfg, { sinceDays: 99999, type: 'session' })[0]!.links,
    ['ACME-7'],
    'L7-84 is not a ticket',
  );
  assert.match(
    readFileSync(join(env.cfg.paths.vault, '09-Tracker/ACME-7.md'), 'utf8'),
    /## Log\n- 2026-11-05 result: Verified PR #157 on nightly/,
  );
  assert.ok(existsSync(join(env.cfg.paths.vault, '09-Tracker/ACME-9.md')));
  assert.equal(syncSessions(env.cfg, now).notes, 0, 're-run adds nothing');
  const old = tmpEnv();
  old.cfg.github.since = '2026-01-01';
  cpSync(dir, join(old.cfg.paths.claude_projects, '-ws'), { recursive: true });
  assert.equal(
    syncSessions(old.cfg, Date.parse('2026-12-01T00:00:00Z')).notes,
    0,
    'old results stay in the timeline only',
  );
});

test('sync report lists its errors, capped', () => {
  const report = { name: 'commits', notes: 1, events: 2, skipped: 0, errors: ['api: a', 'web: b', 'cli: c'] };
  assert.deepEqual(formatSyncReport(report, 2), [
    'commits: 1 notes changed, 2 events added, 0 skipped, 3 errors',
    '  - api: a',
    '  - web: b',
    '  - and 1 more',
  ]);
  assert.deepEqual(formatSyncReport({ ...report, errors: [] }), [
    'commits: 1 notes changed, 2 events added, 0 skipped',
  ]);
});
