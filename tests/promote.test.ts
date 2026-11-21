import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promoteDaily } from '../src/promote.ts';
import { listNotes, writeVaultFile } from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

const DAILY = `---\ntype: daily\ndate: "2026-11-05"\n---\n# 2026-11-05\n\n## Completed\n- [[ACME-7]]: verified [[PR-api-3]] on nightly.\n  - nested detail is skipped\n- None recorded.\n\n## Decisions\n- [[ACME-7]]: keep the 404 for invalid URLs.\n- Line refs like [[L7-84]] are not tickets.\n\n## New knowledge\n- [[api]] returns 404 for a trailing slash.\n- [[nope]] has no card, so nothing happens.\n\n## Tomorrow\n- [[ACME-9]] is only a plan.\n`;

test('promote copies daily bullets to ticket logs and repo traps, once', () => {
  const { cfg } = tmpEnv();
  const v = cfg.paths.vault;
  writeVaultFile(v, '21-Timeline/Daily/2026-11-05.md', DAILY);
  writeVaultFile(v, '04-Repositories/api.md', '---\ntype: repository\n---\n# api\n\n## Traps\n- Old trap.\n');
  assert.deepEqual(promoteDaily(cfg, '21-Timeline/Daily/2026-11-05.md', '2026-11-05'), { tickets: 2, repos: 1 });
  const t = readFileSync(join(v, '09-Tracker/ACME-7.md'), 'utf8');
  assert.match(t, /type: ticket/);
  assert.match(
    t,
    /## Log\n- 2026-11-05 note: \[\[ACME-7\]\]: verified \[\[PR-api-3\]\] on nightly\.\n- 2026-11-05 decision: \[\[ACME-7\]\]: keep the 404/,
  );
  assert.doesNotMatch(t, /nested/);
  assert.match(
    readFileSync(join(v, '04-Repositories/api.md'), 'utf8'),
    /- Old trap\.\n- 2026-11-05: \[\[api\]\] returns 404/,
  );
  assert.ok(!listNotes(v).some((f) => /L7-84|ACME-9|nope/.test(f)));
  assert.deepEqual(
    promoteDaily(cfg, '21-Timeline/Daily/2026-11-05.md', '2026-11-05'),
    { tickets: 0, repos: 0 },
    're-run adds nothing',
  );
});

test('listNotes skips dot folders such as a worktree copy of the vault', () => {
  const { cfg } = tmpEnv();
  writeVaultFile(cfg.paths.vault, 'a.md', '# a\n');
  writeVaultFile(cfg.paths.vault, '.claude/worktrees/x/a.md', '# a\n');
  assert.deepEqual(listNotes(cfg.paths.vault), ['a.md']);
});
