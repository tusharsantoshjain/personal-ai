import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installRoutines, plist, runRoutine, uninstallRoutines, type Exec, type RoutineDeps } from '../src/routines.ts';
import { FakeGh, tmpEnv } from './helpers.ts';

const MON = new Date('2026-10-19T04:00:00Z'); // 09:30 IST Monday
const SAT = new Date('2026-10-17T04:00:00Z');

function deps(now: Date, vaultHasRemote = false) {
  const calls: string[][] = [];
  const notes: string[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return {
      code: 0,
      stdout: args.at(-1) === 'remote' ? (vaultHasRemote ? 'origin' : '') : 'Needs attention\n- api#2: Fix failing CI',
      stderr: '',
    };
  };
  const gh = new FakeGh((args) => (args[0] === 'search' ? [] : null));
  const d: RoutineDeps = { exec, gh, now, notify: (t, x) => notes.push(`${t}: ${x}`) };
  return { d, calls, notes };
}

test('brief writes the answer into the daily note and notifies; skips non-working days', () => {
  const { cfg } = tmpEnv();
  const { d, calls, notes } = deps(MON);
  const r = runRoutine(cfg, 'brief', d);
  assert.equal(r.skipped, undefined);
  assert.deepEqual(calls[0]!.slice(0, 3), ['claude', '-p', 'What needs my attention?']);
  const note = readFileSync(join(cfg.paths.vault, '21-Timeline/Daily/2026-10-19.md'), 'utf8');
  assert.match(note, /## Morning brief \(\d\d:\d\d\)\n\nNeeds attention\n- api#2: Fix failing CI/);
  assert.match(note, /## Tomorrow/);
  assert.deepEqual(notes, ['Morning brief: api#2: Fix failing CI']);
  runRoutine(cfg, 'brief', d);
  assert.equal(
    (readFileSync(join(cfg.paths.vault, '21-Timeline/Daily/2026-10-19.md'), 'utf8').match(/Morning brief/g) ?? [])
      .length,
    1,
    're-run replaces, never duplicates',
  );
  const sat = deps(SAT);
  assert.equal(runRoutine(cfg, 'brief', sat.d).skipped, 'not a working day');
  assert.equal(sat.calls.length, 0);
});

test('eod drafts the daily note (the model never commits), then commits the vault itself and pushes only when it has a remote', () => {
  const { cfg } = tmpEnv();
  const { d, calls } = deps(MON);
  const r = runRoutine(cfg, 'eod', d);
  assert.ok(r.lines.some((l) => l.startsWith('lint:')));
  const c = calls.find((x) => x[0] === 'claude')!;
  assert.ok(c.includes('acceptEdits'));
  assert.match(c[2]!, /Do not commit, push, post or message anyone/);
  assert.ok(r.lines.includes('vault commit: skipped (not a git repo)'));
  assert.ok(!calls.some((x) => x[0] === 'git'));

  mkdirSync(join(cfg.paths.vault, '.git'));
  const g = deps(MON);
  const r2 = runRoutine(cfg, 'eod', g.d);
  const git = g.calls.filter((x) => x[0] === 'git').map((x) => x.slice(3).join(' '));
  assert.deepEqual(git, ['status --porcelain', 'add -A', 'commit -q -m EOD 2026-10-19', 'remote']);
  assert.ok(r2.lines.includes('vault commit: committed'));
  const withRemote = deps(MON, true);
  assert.ok(runRoutine(cfg, 'eod', withRemote.d).lines.includes('vault commit: committed and pushed'));
  assert.equal(
    withRemote.calls
      .filter((x) => x[0] === 'git')
      .at(-1)!
      .slice(3)
      .join(' '),
    'push -q',
  );
});

test('weekly writes the check note without calling the model', () => {
  const { cfg } = tmpEnv();
  const { d, calls } = deps(new Date('2026-10-23T12:30:00Z'));
  runRoutine(cfg, 'weekly', d);
  assert.equal(calls.length, 0);
  const note = readFileSync(join(cfg.paths.vault, '01-Dashboard/Weekly Check.md'), 'utf8');
  assert.match(note, /### Vault lint: \d+ finding/);
  assert.match(note, /### Usage \(7 days\)/);
});

test('launchd plists run weekdays at the set time and install and uninstall cleanly', () => {
  const { cfg } = tmpEnv();
  const p = plist(cfg, 'brief', '/x/node/bin/node');
  assert.match(p, /<string>com\.personal-ai\.brief<\/string>/);
  assert.equal((p.match(/<key>Weekday<\/key>/g) ?? []).length, 5);
  assert.match(p, /<key>Hour<\/key><integer>9<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.match(p, /<string>\/x\/node\/bin:\/opt\/homebrew\/bin/);
  assert.equal((plist(cfg, 'weekly', '/n').match(/<key>Weekday<\/key><integer>5<\/integer>/g) ?? []).length, 1);
  const dir = mkdtempSync(join(tmpdir(), 'la-'));
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = installRoutines(cfg, exec, '/n', dir);
  assert.equal(out.length, 3);
  assert.ok(existsSync(join(dir, 'com.personal-ai.eod.plist')));
  assert.equal(calls.filter((c) => c[1] === 'bootstrap').length, 3);
  assert.deepEqual(uninstallRoutines(exec, dir), ['brief: removed', 'eod: removed', 'weekly: removed']);
  assert.ok(!existsSync(join(dir, 'com.personal-ai.eod.plist')));
});
