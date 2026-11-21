import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ConfigError, levelOf, loadConfig, REPO_ROOT, repoForPath, validateConfig } from '../src/config.ts';
import { tmpEnv } from './helpers.ts';

const example = () =>
  parse(readFileSync(join(REPO_ROOT, 'config', 'assistant.example.yaml'), 'utf8')) as Record<string, any>;

test('example config is valid', () => {
  const cfg = validateConfig(example());
  assert.equal(cfg.assistant.autonomy, 'controlled');
  assert.ok(!cfg.paths.cache_dir.startsWith('~'), 'home is expanded');
});

test('real config, when present, is valid', { skip: !process.env.PAI_CHECK_REAL }, () => {
  loadConfig();
});

test('invalid config lists every problem', () => {
  const raw = example();
  raw.assistant.autonomy = 'yolo';
  raw.approvals.levels.git_commit = 'maybe';
  raw.approvals.levels.not_a_category = 'never';
  raw.commit_formats.default.pattern = '([';
  raw.paths.vault = 'relative/path';
  delete raw.tracker;
  assert.throws(
    () => validateConfig(raw),
    (e: Error) => {
      assert.ok(e instanceof ConfigError);
      for (const s of [
        'assistant.autonomy',
        'approvals.levels.git_commit',
        'not_a_category',
        'invalid regex',
        'paths.vault',
        'tracker.site',
      ])
        assert.match(e.message, new RegExp(s.replace('.', '\\.')));
      return true;
    },
  );
});

test('unknown categories default to controlled, never to safe', () => {
  const { cfg } = tmpEnv();
  delete (cfg.approvals.levels as Record<string, string>).gh_comment;
  assert.equal(levelOf(cfg, 'gh_comment'), 'controlled');
});

test('loadConfig reports unreadable and malformed files', () => {
  assert.throws(() => loadConfig('/nonexistent/x.yaml'), /not readable/);
});

test('repoForPath picks the repo and its worktrees', () => {
  const { cfg } = tmpEnv();
  assert.equal(repoForPath(cfg, join(cfg.paths.workspace, 'api', 'src'))?.name, 'api');
  assert.equal(repoForPath(cfg, join(cfg.paths.workspace, 'api-wt-ACME-1'))?.name, 'api');
  assert.equal(repoForPath(cfg, join(cfg.paths.workspace, 'other')), undefined);
});
