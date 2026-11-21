import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSecrets, maskSecrets } from '../src/secrets.ts';
import {
  appendToSection,
  dedash,
  getSyncBlock,
  parseNote,
  renderNote,
  safeVaultPath,
  SecretError,
  upsertNote,
  upsertSyncBlock,
  VaultPathError,
  writeIfChanged,
  writeVaultFile,
} from '../src/vault.ts';
import { tmpEnv } from './helpers.ts';

test('path validator rejects absolute, traversal and link escapes', () => {
  const { cfg, root } = tmpEnv();
  const v = cfg.paths.vault;
  assert.throws(() => safeVaultPath(v, '/etc/passwd'), VaultPathError);
  assert.throws(() => safeVaultPath(v, '../outside.md'), VaultPathError);
  assert.throws(() => safeVaultPath(v, 'a/../../outside.md'), VaultPathError);
  assert.throws(() => safeVaultPath(v, ''), VaultPathError);
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(v, 'escape'));
  assert.throws(() => safeVaultPath(v, 'escape/note.md'), /escapes the vault/);
  assert.ok(safeVaultPath(v, '02-People/Jane Doe.md').endsWith('Jane Doe.md'));
});

test('atomic write leaves no temp files and refuses secrets', () => {
  const { cfg } = tmpEnv();
  writeVaultFile(cfg.paths.vault, 'a/b.md', 'hello');
  assert.equal(readFileSync(join(cfg.paths.vault, 'a/b.md'), 'utf8'), 'hello');
  assert.deepEqual(readdirSync(join(cfg.paths.vault, 'a')), ['b.md']);
  assert.throws(() => writeVaultFile(cfg.paths.vault, 'x.md', 'token ghp_' + 'a'.repeat(36)), SecretError);
  assert.equal(existsSync(join(cfg.paths.vault, 'x.md')), false);
  assert.equal(writeIfChanged(cfg.paths.vault, 'a/b.md', 'hello'), false);
  assert.equal(writeIfChanged(cfg.paths.vault, 'a/b.md', 'hello2'), true);
});

test('frontmatter round trip keeps quoted wikilinks', () => {
  const text = renderNote({
    data: { type: 'pr', author: '[[Jane Doe]]', reviewers: ['[[Bob Roe]]'], number: 4 },
    body: '# T\n',
  });
  assert.match(text, /author: "\[\[Jane Doe\]\]"/);
  const n = parseNote(text);
  assert.equal(n.data.author, '[[Jane Doe]]');
  assert.deepEqual(n.data.reviewers, ['[[Bob Roe]]']);
  assert.equal(n.body, '# T\n');
});

test('sync blocks replace only their own text', () => {
  const body = '# Note\nmine above\n<!-- sync:x:start -->\nold\n<!-- sync:x:end -->\nmine below\n';
  const next = upsertSyncBlock(body, 'x', 'new $& text');
  assert.equal(next, '# Note\nmine above\n<!-- sync:x:start -->\nnew $& text\n<!-- sync:x:end -->\nmine below\n');
  assert.equal(getSyncBlock(next, 'x'), 'new $& text');
  const fresh = upsertSyncBlock('# Title\nbody\n', 'y', 'gen');
  assert.equal(fresh, '# Title\n<!-- sync:y:start -->\ngen\n<!-- sync:y:end -->\nbody\n');
});

test('appendToSection is idempotent and creates the section', () => {
  let b = '# N\n\n## Log\n- 1\n\n## Other\nx\n';
  b = appendToSection(b, 'Log', '- 2');
  assert.equal(b, '# N\n\n## Log\n- 1\n- 2\n\n## Other\nx\n');
  assert.equal(appendToSection(b, 'Log', '- 2'), b);
  assert.match(appendToSection('# N\n', 'History', '- h'), /## History\n- h\n$/);
});

test('upsertNote keeps owner text and removes dashes from generated text', () => {
  const { cfg } = tmpEnv();
  writeVaultFile(cfg.paths.vault, 'n.md', '---\ntype: pr\nmine: keep\n---\n# T\n\n## Notes\nowner text\n');
  assert.equal(
    upsertNote(cfg.paths.vault, 'n.md', { data: { title: 'A \u2014 B' }, blockId: 'g', block: 'x \u2013 y' }),
    true,
  );
  const t = readFileSync(join(cfg.paths.vault, 'n.md'), 'utf8');
  assert.match(t, /mine: keep/);
  assert.match(t, /owner text/);
  assert.match(t, /title: A - B/);
  assert.match(t, /x - y/);
  assert.equal(
    upsertNote(cfg.paths.vault, 'n.md', { data: { title: 'A \u2014 B' }, blockId: 'g', block: 'x \u2013 y' }),
    false,
    'second run changes nothing',
  );
  assert.equal(dedash('a\u2014b'), 'a - b');
});

test('secret scan finds credential shapes and leaves prose alone', () => {
  assert.equal(findSecrets('We rotate the token in SSM at /prod/app/token every month.').length, 0);
  assert.equal(findSecrets('password: "hunter2hunter2"').length, 1);
  assert.equal(findSecrets('AKIAABCDEFGHIJKLMNOP').length, 1);
  assert.equal(findSecrets('-----BEGIN RSA PRIVATE KEY-----').length, 1);
  assert.equal(maskSecrets('x ghp_' + 'b'.repeat(36) + ' y'), 'x *** y');
});
