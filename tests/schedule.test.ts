import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { isDueNow, lastDueDay, missedRoutines, routineLabel, routineLogPath } from '../src/schedule.ts';
import { tmpEnv } from './helpers.ts';

// tmpEnv uses UTC. 2026-11-13 is a Friday.
const FRI_2000 = new Date('2026-11-13T20:00:00Z');
const FRI_0900 = new Date('2026-11-13T09:00:00Z');
const MON_0800 = new Date('2026-11-16T08:00:00Z');

test('last due day skips days off the schedule and today before the start time', () => {
  const { cfg } = tmpEnv();
  assert.equal(lastDueDay(cfg, 'eod', FRI_2000), '2026-11-13');
  assert.equal(lastDueDay(cfg, 'eod', FRI_0900), '2026-11-12');
  assert.equal(lastDueDay(cfg, 'eod', MON_0800), '2026-11-13', 'the weekend is not due');
  assert.equal(lastDueDay(cfg, 'weekly', MON_0800), '2026-11-13');
});

test('missed routines warn only for installed routines that did not run', () => {
  const { cfg } = tmpEnv();
  const agentsDir = mkdtempSync(join(tmpdir(), 'pai-agents-'));
  for (const name of ['brief', 'eod'] as const) writeFileSync(join(agentsDir, `${routineLabel(name)}.plist`), '');
  const log = (name: 'brief' | 'eod', text: string) => {
    mkdirSync(dirname(routineLogPath(cfg, name)), { recursive: true });
    writeFileSync(routineLogPath(cfg, name), text);
  };
  log('brief', '2026-11-13 09:30 routine brief\n  prs: 1 open\n');
  log('eod', '2026-11-10 19:06 routine eod\n2026-11-12 19:04 routine eod skipped: not a working day\n');
  assert.equal(isDueNow(cfg, 'brief', FRI_2000), false, 'already ran today');
  assert.equal(isDueNow(cfg, 'eod', FRI_2000), true, 'due today and not run');
  assert.equal(isDueNow(cfg, 'eod', FRI_0900), false, 'not yet due today; yesterday is not caught up');
  const warnings = missedRoutines(cfg, FRI_2000, agentsDir);
  assert.equal(warnings.length, 1, 'weekly is not installed, brief ran today');
  assert.match(warnings[0]!, /Routine eod did not run on 2026-11-13 \(last run: 2026-11-12\)/);
  assert.deepEqual(
    missedRoutines(cfg, new Date('2026-11-13T19:30:00Z'), agentsDir),
    [],
    'an hour of grace after the start time',
  );
});
