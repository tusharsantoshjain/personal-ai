import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { find, record, resolve } from '../src/notes.ts';
import { listRuns, setRun, startRun, stepRun } from '../src/runs.ts';
import { addEvents, formatEvent, parseEvent, readEvents } from '../src/timeline.ts';
import { parseNote, writeVaultFile } from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

test('timeline add is idempotent and sorted', () => {
  const { cfg } = tmpEnv();
  const e = (ts: string, id: string) => ({
    ts,
    type: 'note' as const,
    title: `t ${id}`,
    links: ['ACME-1'],
    src: 'owner',
    id,
  });
  assert.equal(addEvents(cfg, [e('2026-10-02 10:00', 'b'), e('2026-10-01 09:00', 'a')]), 2);
  assert.equal(addEvents(cfg, [e('2026-10-02 10:00', 'b')]), 0);
  const text = readFileSync(join(cfg.paths.vault, '21-Timeline/2026-10.md'), 'utf8');
  assert.ok(text.indexOf('^a') < text.indexOf('^b'));
  assert.equal(readEvents(cfg, { entity: 'ACME-1' }).length, 2);
  assert.throws(() => addEvents(cfg, [{ ...e('2026-10-02 10:00', 'c'), type: 'bogus' as never }]));
});

test('timeline line format round trips', () => {
  const line = formatEvent({
    ts: '2026-09-24 14:53',
    type: 'pr-merged',
    title: 'api#486 Fix | pipes',
    links: ['PR-api-486', 'ACME-123'],
    src: 'github',
    id: 'pr-api-486-merged',
  });
  assert.equal(
    line,
    '- 2026-09-24 14:53 | pr-merged | api#486 Fix pipes | [[PR-api-486]] [[ACME-123]] | src: github ^pr-api-486-merged',
  );
  assert.equal(parseEvent(line)?.links[1], 'ACME-123');
});

test('record writes target log, person history and one event; re-run is a no-op', () => {
  const { cfg } = tmpEnv();
  const r1 = record(cfg, 'decision', 'Use squash merge only', ['ACME-12', 'api#7'], ['bob-gh']);
  assert.equal(r1.timelineAdded, 1);
  assert.equal(r1.written.length, 3);
  const ticket = parseNote(readFileSync(join(cfg.paths.vault, '09-Tracker/ACME-12.md'), 'utf8'));
  assert.equal(ticket.data.type, 'ticket');
  assert.match(ticket.body, /## Log\n- \d{4}-\d{2}-\d{2} decision: Use squash merge only \(with \[\[Bob Roe\]\]\)/);
  assert.match(readFileSync(join(cfg.paths.vault, '11-PRs/PR-api-7.md'), 'utf8'), /decision: Use squash merge only/);
  const person = readFileSync(join(cfg.paths.vault, '02-People/Bob Roe.md'), 'utf8');
  assert.match(person, /## History\n- .* decision: Use squash merge only \(on \[\[ACME-12\]\], \[\[PR-api-7\]\]\)/);
  const r2 = record(cfg, 'decision', 'Use squash merge only', ['ACME-12', 'api#7'], ['bob-gh']);
  assert.deepEqual(r2, { written: [], timelineAdded: 0 });
  assert.throws(() => record(cfg, 'decision', 'bad \u2014 dash', ['ACME-12'], []), /dash/);
  assert.throws(() => record(cfg, 'note', 'x', ['Nobody Known'], []), /target not found/);
});

test('find and resolve use titles, aliases and config aliases', () => {
  const { cfg } = tmpEnv();
  writeVaultFile(
    cfg.paths.vault,
    '02-People/Bob Roe.md',
    '---\ntype: person\naliases: [Bobby]\n---\n# Bob Roe\nWorks on payments.\n',
  );
  writeVaultFile(
    cfg.paths.vault,
    '07-Decisions/ADR-1 Payments queue.md',
    '---\ntype: decision\n---\n# Queue\nWe chose SQS for payments.\n',
  );
  assert.equal(resolve(cfg, 'bob-gh')?.name, 'Bob Roe');
  assert.equal(resolve(cfg, 'Bobby')?.path, '02-People/Bob Roe.md');
  assert.equal(resolve(cfg, '@bob-gh')?.name, 'Bob Roe');
  assert.equal(resolve(cfg, 'Nobody'), undefined);
  const hits = find(cfg, 'payments');
  assert.equal(hits.length, 2);
  assert.equal(find(cfg, 'bob roe')[0]?.path, '02-People/Bob Roe.md');
});

test('runs recover from a failed step', () => {
  const { cfg } = tmpEnv();
  const name = startRun(cfg, 'fix', 'ACME-5');
  assert.equal(startRun(cfg, 'fix', 'ACME-5'), name, 'start twice resumes the same run');
  stepRun(cfg, name, 'intake', 'done', 'base develop', 'investigate');
  stepRun(cfg, name, 'investigate', 'done', '', 'implement');
  stepRun(cfg, name, 'implement', 'failed', 'tsc error');
  let d = listRuns(cfg, { open: true })[0]!.data;
  assert.equal(d.current_step, 'implement');
  assert.deepEqual(d.completed_steps, ['intake', 'investigate']);
  assert.deepEqual(d.failed_steps, ['implement']);
  stepRun(cfg, name, 'implement', 'done', 'fixed', 'validate');
  setRun(cfg, name, 'branch', 'fix/ACME-5-x');
  setRun(cfg, name, 'agents', 'implementer');
  d = listRuns(cfg, { open: true })[0]!.data;
  assert.equal(d.current_step, 'validate');
  assert.deepEqual(d.failed_steps, []);
  assert.equal(d.branch, 'fix/ACME-5-x');
  assert.throws(() => setRun(cfg, name, 'type', 'x'), /not settable/);
  setRun(cfg, name, 'status', 'done');
  assert.equal(listRuns(cfg, { open: true }).length, 0);
});
