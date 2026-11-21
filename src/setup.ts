import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { writeFileAtomic } from './files.ts';
import { handle } from './hook.ts';

const settingsPathOf = (cfg: Config) => join(cfg.paths.workspace, '.claude', 'settings.json');
const vaultMemoryDir = (cfg: Config) => join(cfg.paths.vault, cfg.vault.memory_folder);
/** Where Claude Code looks for this workspace's memory; install links it to the vault. */
const claudeMemoryLink = (cfg: Config) => join(cfg.paths.claude_projects, cfg.paths.claude_project_slug, 'memory');
const skillsSourceDir = (cfg: Config) => join(cfg.paths.assistant_repo, 'claude', 'skills');
const skillNames = (cfg: Config) =>
  existsSync(skillsSourceDir(cfg))
    ? readdirSync(skillsSourceDir(cfg), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

export const hookCommand = (cfg: Config) => `bash ${join(cfg.paths.assistant_repo, 'bin', 'hook')}`;
const PAI = (cfg: Config) => join(cfg.paths.assistant_repo, 'bin', 'pai');

/** The parts of the workspace settings this engine owns. Other keys in the file are left alone. */
export function desiredSettings(cfg: Config) {
  const hook = [{ type: 'command', command: hookCommand(cfg) }];
  return {
    model: cfg.assistant.model ?? 'opus',
    effortLevel: cfg.assistant.effort ?? 'medium',
    autoMemoryDirectory: vaultMemoryDir(cfg),
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false,
    permissions: {
      allow: [
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(git diff:*)',
        'Bash(git show:*)',
        'Bash(git branch -vv:*)',
        'Bash(git branch --list:*)',
        'Bash(git rev-parse:*)',
        'Bash(git fetch:*)',
        'Bash(git worktree list:*)',
        'Bash(git remote -v:*)',
        'Bash(git blame:*)',
        'Bash(git ls-files:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr list:*)',
        'Bash(gh pr checks:*)',
        'Bash(gh pr diff:*)',
        'Bash(gh pr status:*)',
        'Bash(gh search:*)',
        'Bash(gh issue view:*)',
        'Bash(gh issue list:*)',
        'Bash(gh run view:*)',
        'Bash(gh run list:*)',
        'Bash(gh repo view:*)',
        'Bash(pai:*)',
        `Bash(${PAI(cfg)}:*)`,
        `Bash(node ${join(cfg.paths.assistant_repo, 'src', 'cli.ts')}:*)`,
        'mcp__claude_ai_Atlassian_Rovo__getJiraIssue',
        'mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql',
        'mcp__claude_ai_Atlassian_Rovo__getConfluencePage',
        'mcp__claude_ai_Atlassian_Rovo__searchConfluenceUsingCql',
        'mcp__claude_ai_Atlassian_Rovo__search',
        'mcp__claude_ai_Atlassian_Rovo__fetch',
        'mcp__claude_ai_Atlassian_Rovo__getTransitionsForJiraIssue',
        'mcp__claude_ai_Atlassian_Rovo__getJiraIssueRemoteIssueLinks',
        'mcp__claude_ai_Atlassian_Rovo__getConfluencePageDescendants',
        'mcp__claude_ai_Slack__slack_search_public_and_private',
        'mcp__claude_ai_Slack__slack_read_channel',
        'mcp__claude_ai_Slack__slack_read_thread',
        'mcp__claude_ai_Slack__slack_search_users',
        'mcp__claude_ai_Slack__slack_read_user_profile',
        'mcp__claude_ai_Gmail__search_threads',
        'mcp__claude_ai_Gmail__get_thread',
        'mcp__claude_ai_Gmail__get_message',
        'mcp__claude_ai_Google_Drive__search_files',
        'mcp__claude_ai_Google_Drive__read_file_content',
        'mcp__claude_ai_Google_Drive__get_file_metadata',
      ],
      deny: [
        'Bash(gh pr merge:*)',
        'Bash(git push --force:*)',
        'Bash(git push -f:*)',
        'Read(**/.env)',
        'Read(**/.env.*)',
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|Read|Agent|Task|mcp__.*', hooks: hook },
      ],
      PostToolUse: [{ matcher: 'AskUserQuestion', hooks: hook }],
      SubagentStop: [{ hooks: hook }],
      SessionStart: [{ hooks: hook }],
    },
  };
}

type Settings = Record<string, unknown> & {
  permissions?: { allow?: string[]; deny?: string[] };
  hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
};

/** Merge desired settings into an existing file: our hooks replace older copies of themselves, permission lists are unioned. */
export function mergeSettings(cfg: Config, current: Settings): Settings {
  const want = desiredSettings(cfg);
  const cmd = hookCommand(cfg);
  const out: Settings = {
    ...current,
    model: want.model,
    effortLevel: want.effortLevel,
    autoMemoryDirectory: want.autoMemoryDirectory,
    attribution: want.attribution,
    includeCoAuthoredBy: false,
  };
  out.permissions = {
    ...(current.permissions ?? {}),
    allow: [...new Set([...(current.permissions?.allow ?? []), ...want.permissions.allow])],
    deny: [...new Set([...(current.permissions?.deny ?? []), ...want.permissions.deny])],
  };
  const hooks: NonNullable<Settings['hooks']> = { ...(current.hooks ?? {}) };
  for (const [event, entries] of Object.entries(want.hooks)) {
    const others = (hooks[event] ?? []).filter(
      (e) => !e.hooks.some((h) => h.command === cmd || h.command.endsWith('/bin/hook')),
    );
    hooks[event] = [...others, ...(entries as { matcher?: string; hooks: { command: string }[] }[])];
  }
  out.hooks = hooks;
  return out;
}

/** Make `path` a symlink to `target`; an empty folder there is replaced, anything else is an error. */
function ensureSymlink(target: string, path: string, log: string[]): void {
  if (existsSync(path) || isLink(path)) {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      if (resolve(join(path, '..'), readlinkSync(path)) === target) return;
      throw new Error(`${path} links elsewhere (${readlinkSync(path)}); remove it first`);
    }
    if (st.isDirectory() && readdirSync(path).filter((f) => f !== '.DS_Store').length === 0) rmdirSync(path);
    else
      throw new Error(
        `${path} exists and is not empty; move its contents first (run \`pai sync memory\` for a memory folder)`,
      );
  }
  symlinkSync(target, path, 'dir');
  log.push(`linked ${path} -> ${target}`);
}
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export function install(cfg: Config): string[] {
  const log: string[] = [];
  const ws = cfg.paths.workspace;
  const repo = cfg.paths.assistant_repo;
  mkdirSync(join(ws, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(ws, '.scratch'), { recursive: true });
  mkdirSync(cfg.paths.cache_dir, { recursive: true });
  mkdirSync(cfg.paths.logs_dir, { recursive: true });
  ensureSymlink(join(repo, 'claude', 'agents'), join(ws, '.claude', 'agents'), log);
  const skillsSrc = skillsSourceDir(cfg);
  const skills = skillNames(cfg);
  for (const s of skills) ensureSymlink(join(skillsSrc, s), join(ws, '.claude', 'skills', s), log);
  for (const s of readdirSync(join(ws, '.claude', 'skills'))) {
    const p = join(ws, '.claude', 'skills', s);
    if (isLink(p) && readlinkSync(p).startsWith(skillsSrc) && !skills.includes(s)) {
      unlinkSync(p);
      log.push(`removed stale skill link ${s}`);
    }
  }
  const mem = vaultMemoryDir(cfg);
  mkdirSync(mem, { recursive: true });
  if (!existsSync(join(mem, 'MEMORY.md'))) writeFileSync(join(mem, 'MEMORY.md'), '');
  mkdirSync(dirname(claudeMemoryLink(cfg)), { recursive: true });
  ensureSymlink(mem, claudeMemoryLink(cfg), log);
  const settingsPath = settingsPathOf(cfg);
  const current = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings) : {};
  const merged = mergeSettings(cfg, current);
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (!existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== text) {
    writeFileAtomic(settingsPath, text);
    log.push(`wrote ${settingsPath}`);
  }
  if (!log.length) log.push('nothing to do; already installed');
  return log;
}

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function doctor(configPath?: string): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail = '') => checks.push({ name, status, detail });
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  add('node', maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'fail', process.versions.node);
  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
    add('config', 'ok', 'valid');
  } catch (e) {
    add('config', 'fail', (e as Error).message);
    return checks;
  }
  add('vault', existsSync(cfg.paths.vault) ? 'ok' : 'fail', cfg.paths.vault);
  for (const [n, p] of [
    ['cache dir', cfg.paths.cache_dir],
    ['logs dir', cfg.paths.logs_dir],
  ] as const) {
    try {
      mkdirSync(p, { recursive: true });
      accessSync(p, constants.W_OK);
      add(n, 'ok', p);
    } catch (e) {
      add(n, 'fail', (e as Error).message);
    }
  }
  const hookBin = join(cfg.paths.assistant_repo, 'bin', 'hook');
  add('hook script', existsSync(hookBin) ? 'ok' : 'fail', hookBin);
  const settingsPath = settingsPathOf(cfg);
  if (!existsSync(settingsPath)) add('workspace settings', 'fail', `${settingsPath} missing; run \`pai install\``);
  else {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const cmd = hookCommand(cfg);
    const missing = ['PreToolUse', 'PostToolUse', 'SubagentStop', 'SessionStart'].filter(
      (e) => !(s.hooks?.[e] ?? []).some((x) => x.hooks.some((h) => h.command === cmd)),
    );
    add('hooks wired', missing.length ? 'fail' : 'ok', missing.length ? `missing: ${missing.join(', ')}` : cmd);
    const attr = s.attribution as { commit?: string; pr?: string } | undefined;
    add('attribution off', attr?.commit === '' && attr?.pr === '' ? 'ok' : 'fail', JSON.stringify(attr ?? null));
    add(
      'autoMemoryDirectory',
      s.autoMemoryDirectory === vaultMemoryDir(cfg) ? 'ok' : 'fail',
      String(s.autoMemoryDirectory ?? 'unset'),
    );
    const deny = s.permissions?.deny ?? [];
    add(
      'deny backstop',
      ['Bash(gh pr merge:*)', 'Bash(git push --force:*)'].every((d) => deny.includes(d)) ? 'ok' : 'fail',
      deny.join(', '),
    );
  }
  const agentsLink = join(cfg.paths.workspace, '.claude', 'agents');
  add(
    'agents link',
    isLink(agentsLink) && resolve(readlinkSync(agentsLink)) === join(cfg.paths.assistant_repo, 'claude', 'agents')
      ? 'ok'
      : 'fail',
    agentsLink,
  );
  const skills = skillNames(cfg);
  const unlinked = skills.filter((s) => !isLink(join(cfg.paths.workspace, '.claude', 'skills', s)));
  add(
    'skills linked',
    unlinked.length ? 'fail' : 'ok',
    unlinked.length ? `not linked: ${unlinked.join(', ')}` : `${skills.length} skills`,
  );
  const memoryLink = claudeMemoryLink(cfg);
  add(
    'memory link',
    isLink(memoryLink) && resolve(dirname(memoryLink), readlinkSync(memoryLink)) === vaultMemoryDir(cfg)
      ? 'ok'
      : 'fail',
    memoryLink,
  );
  // Hook self-test through the real script: a dangerous call must be denied, a harmless one must pass, a broken config must ask.
  const run = (input: object, env: Record<string, string> = {}) => {
    try {
      return execFileSync('bash', [hookBin], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 15000,
      });
    } catch (e) {
      return `ERROR ${(e as Error).message}`;
    }
  };
  const deny = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push --force origin develop' },
    cwd: cfg.paths.workspace,
    session_id: 'doctor',
  });
  add('gate denies force push', /"permissionDecision":"deny"/.test(deny) ? 'ok' : 'fail', deny.slice(0, 120));
  const pass = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    cwd: cfg.paths.workspace,
    session_id: 'doctor',
  });
  add('gate passes harmless call', pass.trim() === '' ? 'ok' : 'fail', pass.slice(0, 120) || 'no output');
  const broken = run(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m x' },
      cwd: cfg.paths.workspace,
    },
    { PAI_CONFIG: '/nonexistent/assistant.yaml', PAI_LOGS_DIR: join(tmpdir(), 'pai-doctor-logs') },
  );
  add('gate fails closed', /"permissionDecision":"ask"/.test(broken) ? 'ok' : 'fail', broken.slice(0, 120));
  add('handle() smoke', handle('not json').includes('"ask"') ? 'ok' : 'fail', 'bad input asks');
  for (const acc of cfg.github.accounts) {
    try {
      execFileSync('gh', ['auth', 'token', '--user', acc.login], { stdio: ['ignore', 'ignore', 'ignore'] });
      add(`gh login ${acc.login}`, 'ok', acc.orgs.join(', '));
    } catch {
      add(`gh login ${acc.login}`, 'fail', 'no token; run gh auth login');
    }
  }
  try {
    execFileSync('sh', ['-c', 'command -v pai'], { stdio: 'ignore' });
    add('pai on PATH', 'ok');
  } catch {
    add('pai on PATH', 'warn', 'agents and skills call `pai`; run `npm link` in the assistant repo');
  }
  add(
    'profile',
    existsSync(cfg.paths.profile) ? 'ok' : 'warn',
    existsSync(cfg.paths.profile) ? cfg.paths.profile : `${cfg.paths.profile} not written yet (Phase 4)`,
  );
  return checks;
}
