import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { REPO_ROOT, validateConfig, type Config } from '../src/config.ts';
import type { GhClient } from '../src/gh.ts';

// Hook calls without a usable config log here instead of the repo's real logs/ folder.
process.env.PAI_LOGS_DIR ??= mkdtempSync(join(tmpdir(), 'pai-test-logs-'));

export interface Env {
  root: string;
  cfg: Config;
  cfgPath: string;
  home: string;
}

/** A disposable workspace + vault + cache, with the example config pointed at it. Never touches the real vault. */
export function tmpEnv(overrides: (raw: Record<string, any>) => void = () => {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'pai-test-'));
  const raw = parse(readFileSync(join(REPO_ROOT, 'config', 'assistant.example.yaml'), 'utf8')) as Record<string, any>;
  const ws = join(root, 'ws');
  raw.paths = {
    workspace: ws,
    vault: join(ws, 'Vault'),
    assistant_repo: REPO_ROOT,
    cache_dir: join(root, 'cache'),
    logs_dir: join(root, 'logs'),
    profile: join(ws, 'assistant-profile.md'),
    claude_projects: join(root, 'claude-projects'),
    claude_project_slug: '-ws',
  };
  raw.assistant.owner = 'Jane Doe';
  raw.assistant.timezone = 'UTC';
  raw.people = {
    self: 'Jane Doe',
    aliases: { 'jane-doe': 'Jane Doe', 'bob-gh': 'Bob Roe', 'Bob R': 'Bob Roe' },
    bots: ['github-actions', 'dependabot[bot]'],
  };
  raw.github.protected_branches = ['main', 'develop', 'release/*'];
  raw.commit_formats = {
    default: { pattern: '^(ACME-\\d+: |#noissue - )\\S', example: 'ACME-1: Fix it' },
    conv: { pattern: '^(feat|fix)\\(WEB-\\d+\\): \\S', required_trailer: '^Human-authored: .+' },
  };
  raw.repositories = [
    {
      name: 'api',
      path: 'api',
      org: 'example-org',
      project: 'ACME',
      stack: 'node-ts',
      default_branch: 'develop',
      commit_format: 'default',
    },
    {
      name: 'web',
      path: 'web',
      org: 'example-org',
      project: 'WEB',
      stack: 'nx',
      default_branch: 'main',
      commit_format: 'conv',
    },
  ];
  raw.approvals.levels = {
    git_commit: 'controlled',
    git_push: 'controlled',
    git_push_protected: 'never',
    git_force_push: 'never',
    gh_pr_create_ready: 'never',
    gh_pr_merge: 'never',
    gh_review_published: 'never',
    secrets_change: 'never',
    secret_read: 'never',
    package_publish: 'never',
    approval_forgery: 'never',
    text_secret: 'never',
    text_dash: 'never',
    text_attribution: 'never',
    text_hardwrap: 'never',
    commit_format: 'never',
    scratch_location: 'never',
    agent_cap: 'never',
    gh_admin: 'never',
  };
  raw.approvals.frozen_paths = [{ pattern: '/legacy/', reason: 'Legacy is frozen.' }];
  overrides(raw);
  mkdirSync(join(ws, 'Vault'), { recursive: true });
  mkdirSync(join(ws, 'api'), { recursive: true });
  const cfgPath = join(root, 'assistant.yaml');
  writeFileSync(cfgPath, stringify(raw));
  return { root, cfg: validateConfig(structuredClone(raw)), cfgPath, home: join(root, 'home') };
}

/** Fake gh: maps a key built from the args to canned JSON. Unknown calls throw so tests see them. */
export class FakeGh implements GhClient {
  calls: string[][] = [];
  private responder: (args: string[]) => unknown;
  constructor(responder: (args: string[]) => unknown) {
    this.responder = responder;
  }
  json<T>(_login: string, args: string[]): T {
    this.calls.push(args);
    return this.responder(args) as T;
  }
}

export const noGit = { branch: () => 'feature/x', isMainCheckout: () => false };
export const mainGit = { branch: () => 'develop', isMainCheckout: () => true };
