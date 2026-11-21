import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/config.ts';
import { tmpEnv } from './helpers.ts';

function cli(cfgPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PAI_CONFIG: cfgPath },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('cli: help, unknown commands and bad arguments', () => {
  const { cfgPath } = tmpEnv();
  assert.match(cli(cfgPath, 'help').out, /^pai: personal assistant CLI/);
  assert.deepEqual([cli(cfgPath, 'nope').code, cli(cfgPath, 'toString').code], [1, 1]);
  assert.match(cli(cfgPath, 'nope').err, /unknown command: nope/);
  assert.match(cli(cfgPath, 'sync', 'nope').err, /unknown sync: nope/);
  assert.equal(cli(cfgPath, 'routine', 'nope').code, 1);
  assert.match(cli('/nonexistent.yaml', 'now').err, /config not readable/);
});

test('cli: record, timeline, runs and text lint work end to end', () => {
  const { cfgPath } = tmpEnv();
  assert.match(
    cli(cfgPath, 'record', 'note', 'Releases freeze on Thursdays', '--on', 'ACME-1').out,
    /^recorded: .*ACME-1\.md \(\+timeline\)/,
  );
  assert.match(
    cli(cfgPath, 'record', 'note', 'Releases freeze on Thursdays', '--on', 'ACME-1').out,
    /already recorded/,
  );
  assert.match(
    cli(cfgPath, 'timeline', 'show', '--entity', 'ACME-1').out,
    /note Releases freeze on Thursdays \[ACME-1\]/,
  );
  const run = cli(cfgPath, 'run', 'start', 'fix', 'ACME-1').out.trim();
  assert.match(run, /-fix-ACME-1$/);
  assert.equal(cli(cfgPath, 'run', 'step', run, 'intake', 'done', '--next', 'plan').out, 'ok\n');
  assert.equal(cli(cfgPath, 'run', 'show').out, `${run}: active at plan\n`);
  const lint = cli(cfgPath, 'lint', 'text', 'Fixed it — done');
  assert.equal(lint.code, 1);
  assert.match(lint.out, /error: dash/);
});
