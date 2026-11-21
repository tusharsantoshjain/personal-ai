import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrub } from '../src/scrub.ts';
import { tmpEnv } from './helpers.ts';

test('scrub removes student data and keeps engineering text', () => {
  const { cfg } = tmpEnv((raw) => {
    raw.people.aliases['bob@acme.com'] = 'Bob Roe';
  });
  const s = (t: string) => scrub(cfg, t);
  assert.equal(s('Student: Maria Lopez, grade 3'), 'Student: [redacted], grade 3');
  assert.equal(s('username=jdoe42 failed'), 'username=[redacted] failed');
  assert.equal(s('Repro with teacher name: Ms Clark'), 'Repro with teacher name: [redacted]');
  assert.equal(s('mail kid.parent@gmail.com or bob@acme.com'), 'mail [email] or bob@acme.com');
  assert.equal(s('login realize_teacher / testing123$'), 'login [credentials]');
  assert.equal(s('userId 3f2b1c4d-1111-2222-3333-444455556666 and 123456789'), 'userId [id] and [id]');
  const keep =
    'Fix ACME-16063 in billing-webapp: guard the session check (commit abc1234, PR #142, 2026-10-10, port 9010).';
  assert.equal(s(keep), keep);
  assert.equal(s('merge develop / master'), 'merge develop / master');
  assert.equal(
    s('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here'),
    'token *** here',
  );
});

test('logins map to names by org prefix; app/ logins are bots', async () => {
  const { person, isBot } = await import('../src/sync/github.ts');
  const { cfg } = tmpEnv((raw) => {
    raw.people.login_prefixes = ['Acme', 'ACME', 'Globex'];
  });
  assert.equal(person(cfg, 'AcmeJaneRoe'), 'Jane Roe');
  assert.equal(person(cfg, 'ACME-Kim-Lee'), 'Kim Lee');
  assert.equal(person(cfg, 'GlobexSamPark10'), 'Sam Park');
  assert.equal(person(cfg, 'bob-gh'), 'Bob Roe', 'config aliases win');
  assert.equal(person(cfg, 'octocat'), 'octocat', 'unknown logins stay as is');
  assert.equal(isBot(cfg, 'app/dependabot'), true);
  assert.equal(isBot(cfg, 'AcmeJaneRoe'), false);
});
