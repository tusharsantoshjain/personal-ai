import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type Level = 'safe' | 'controlled' | 'never';
export type Autonomy = 'manual' | 'assisted' | 'controlled' | 'autonomous';

export interface Repo {
  name: string;
  path: string;
  org: string;
  project: string;
  stack: string;
  default_branch: string;
  commit_format?: string;
  purpose?: string;
  read_only?: boolean;
}

export interface CommitFormat {
  pattern: string;
  example?: string;
  required_trailer?: string;
}

export interface Config {
  assistant: {
    name: string;
    owner: string;
    autonomy: Autonomy;
    timezone: string;
    working_days: string[];
    max_parallel_agents: number;
    model?: string;
    effort?: string;
  };
  paths: {
    workspace: string;
    vault: string;
    assistant_repo: string;
    cache_dir: string;
    logs_dir: string;
    profile: string;
    claude_projects: string;
    claude_project_slug: string;
  };
  vault: {
    folders: Record<string, string>;
    type_folders: Record<string, string>;
    memory_folder: string;
    runs_folder: string;
    lint_exclude: string[];
  };
  github: {
    since: string;
    stale_days: number;
    protected_branches: string[];
    accounts: { login: string; orgs: string[] }[];
  };
  tracker: { kind: string; site: string; projects: string[]; account_id: string };
  people: { self: string; aliases: Record<string, string>; bots: string[]; login_prefixes?: string[] };
  commit_formats: Record<string, CommitFormat>;
  repositories: Repo[];
  approvals: {
    ask_in_chat: boolean;
    levels: Record<string, Level>;
    autonomous_allow: string[];
    frozen_paths: { pattern: string; reason: string }[];
  };
  writing: {
    banned_chars: string[];
    ai_attribution: string[];
    slop_phrases: string[];
    max_chars: Record<string, number>;
  };
  session_start: { max_lines: number; now_max_age_hours: number };
  integrations: Record<string, boolean>;
  polling: Record<string, number>;
  notifications: Record<string, unknown>;
  kpis: unknown[];
  pricing: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>;
  standup?: { time?: string; days_off?: string[] };
}

/** Every category the gate can emit. A category missing from approvals.levels counts as controlled. */
export const CATEGORIES = [
  'git_commit',
  'git_amend',
  'git_no_verify',
  'git_push',
  'git_push_protected',
  'git_force_push',
  'git_force_with_lease',
  'git_branch_delete',
  'git_destructive',
  'git_add_all_main',
  'gh_pr_create_draft',
  'gh_pr_create_ready',
  'gh_pr_ready',
  'gh_pr_merge',
  'gh_close',
  'gh_pr_edit',
  'gh_pr_retarget',
  'gh_request_review',
  'gh_comment',
  'gh_review_pending',
  'gh_review_published',
  'gh_api_write',
  'gh_admin',
  'gh_workflow_dispatch',
  'tracker_comment',
  'tracker_transition',
  'tracker_edit',
  'tracker_create',
  'wiki_write',
  'error_tracker_write',
  'chat_send',
  'email_send',
  'mail_edit',
  'drive_write',
  'connector_write',
  'recursive_delete',
  'frozen_edit',
  'db_destructive',
  'cloud_write',
  'config_edit',
  'engine_edit',
  'secrets_change',
  'secret_read',
  'package_publish',
  'approval_forgery',
  'text_secret',
  'text_dash',
  'text_attribution',
  'text_hardwrap',
  'commit_format',
  'scratch_location',
  'agent_cap',
] as const;
export type Category = (typeof CATEGORIES)[number];

export class ConfigError extends Error {}

const LEVELS = new Set(['safe', 'controlled', 'never']);
const AUTONOMY = new Set(['manual', 'assisted', 'controlled', 'autonomous']);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'config', 'assistant.yaml');

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a parsed YAML document. Collects every problem instead of stopping at the first. */
export function validateConfig(raw: unknown): Config {
  const errors: string[] = [];
  const need = (o: unknown, path: string, kind: 'string' | 'number' | 'boolean' | 'object' | 'array'): unknown => {
    const v = path.split('.').reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
    const ok = kind === 'array' ? Array.isArray(v) : kind === 'object' ? isObj(v) : typeof v === kind;
    if (!ok) errors.push(`${path}: expected ${kind}`);
    return v;
  };
  if (!isObj(raw)) throw new ConfigError('config: expected a mapping at the top level');

  for (const p of ['assistant.name', 'assistant.owner', 'assistant.timezone']) need(raw, p, 'string');
  const autonomy = need(raw, 'assistant.autonomy', 'string');
  if (typeof autonomy === 'string' && !AUTONOMY.has(autonomy))
    errors.push(`assistant.autonomy: unknown value "${autonomy}"`);
  for (const key of ['model', 'effort']) {
    const v = (raw.assistant as Obj | undefined)?.[key];
    if (v !== undefined && typeof v !== 'string') errors.push(`assistant.${key}: expected string`);
  }
  const maxAgents = need(raw, 'assistant.max_parallel_agents', 'number');
  if (typeof maxAgents === 'number' && (maxAgents < 1 || !Number.isInteger(maxAgents)))
    errors.push('assistant.max_parallel_agents: must be a positive integer');

  for (const p of [
    'workspace',
    'vault',
    'assistant_repo',
    'cache_dir',
    'logs_dir',
    'profile',
    'claude_projects',
    'claude_project_slug',
  ]) {
    const v = need(raw, `paths.${p}`, 'string');
    if (typeof v === 'string' && p !== 'claude_project_slug' && !isAbsolute(expandHome(v)))
      errors.push(`paths.${p}: must be absolute or start with ~`);
  }
  need(raw, 'vault.folders', 'object');
  need(raw, 'vault.type_folders', 'object');
  need(raw, 'vault.memory_folder', 'string');
  need(raw, 'vault.runs_folder', 'string');
  need(raw, 'vault.lint_exclude', 'array');
  const folders = (raw.vault as Obj | undefined)?.folders;
  const typeFolders = (raw.vault as Obj | undefined)?.type_folders;
  if (isObj(folders) && isObj(typeFolders)) {
    for (const [t, f] of Object.entries(typeFolders))
      if (typeof f !== 'string' || !(f in folders))
        errors.push(`vault.type_folders.${t}: "${String(f)}" is not a key of vault.folders`);
    for (const k of ['dashboard', 'people', 'tracker', 'prs', 'timeline', 'daily', 'sources', 'system', 'repositories'])
      if (!(k in folders)) errors.push(`vault.folders.${k}: missing`);
  }

  need(raw, 'github.since', 'string');
  need(raw, 'github.protected_branches', 'array');
  const accounts = need(raw, 'github.accounts', 'array');
  if (Array.isArray(accounts))
    accounts.forEach((a, i) => {
      if (!isObj(a) || typeof a.login !== 'string' || !Array.isArray(a.orgs))
        errors.push(`github.accounts[${i}]: needs login and orgs`);
    });
  need(raw, 'tracker.site', 'string');
  need(raw, 'tracker.projects', 'array');
  need(raw, 'people.self', 'string');
  need(raw, 'people.aliases', 'object');
  need(raw, 'people.bots', 'array');

  const formats = need(raw, 'commit_formats', 'object');
  if (isObj(formats)) {
    for (const [k, f] of Object.entries(formats)) {
      if (!isObj(f) || typeof f.pattern !== 'string') {
        errors.push(`commit_formats.${k}: needs pattern`);
        continue;
      }
      for (const key of ['pattern', 'required_trailer'] as const) {
        const re = f[key];
        if (typeof re === 'string')
          try {
            new RegExp(re, 'm');
          } catch {
            errors.push(`commit_formats.${k}.${key}: invalid regex`);
          }
      }
    }
  }
  const repos = need(raw, 'repositories', 'array');
  if (Array.isArray(repos))
    repos.forEach((r, i) => {
      if (!isObj(r)) return errors.push(`repositories[${i}]: expected mapping`);
      for (const k of ['name', 'path', 'org', 'project', 'stack', 'default_branch'])
        if (typeof r[k] !== 'string') errors.push(`repositories[${i}].${k}: expected string`);
      if (typeof r.commit_format === 'string' && isObj(formats) && !(r.commit_format in formats))
        errors.push(`repositories[${i}].commit_format: unknown "${r.commit_format}"`);
    });

  need(raw, 'approvals.ask_in_chat', 'boolean');
  const levels = need(raw, 'approvals.levels', 'object');
  if (isObj(levels))
    for (const [k, v] of Object.entries(levels)) {
      if (!(CATEGORIES as readonly string[]).includes(k)) errors.push(`approvals.levels.${k}: unknown category`);
      if (typeof v !== 'string' || !LEVELS.has(v))
        errors.push(`approvals.levels.${k}: must be safe, controlled or never`);
    }
  const allow = need(raw, 'approvals.autonomous_allow', 'array');
  if (Array.isArray(allow))
    for (const k of allow)
      if (!(CATEGORIES as readonly string[]).includes(String(k)))
        errors.push(`approvals.autonomous_allow: unknown category "${String(k)}"`);
  const frozen = need(raw, 'approvals.frozen_paths', 'array');
  if (Array.isArray(frozen))
    frozen.forEach((f, i) => {
      if (!isObj(f) || typeof f.pattern !== 'string' || typeof f.reason !== 'string')
        errors.push(`approvals.frozen_paths[${i}]: needs pattern and reason`);
    });

  for (const p of ['banned_chars', 'ai_attribution', 'slop_phrases']) need(raw, `writing.${p}`, 'array');
  need(raw, 'writing.max_chars', 'object');
  need(raw, 'session_start.max_lines', 'number');
  need(raw, 'session_start.now_max_age_hours', 'number');

  const su = (raw as Obj).standup;
  if (su !== undefined) {
    if (!isObj(su)) errors.push('standup: expected mapping');
    else {
      if (su.time !== undefined && (typeof su.time !== 'string' || !/^\d{2}:\d{2}$/.test(su.time)))
        errors.push('standup.time: expected "HH:MM"');
      if (
        su.days_off !== undefined &&
        (!Array.isArray(su.days_off) || su.days_off.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(String(d))))
      )
        errors.push('standup.days_off: expected YYYY-MM-DD dates');
    }
  }
  if (errors.length) throw new ConfigError(`config invalid:\n- ${errors.join('\n- ')}`);

  const cfg = raw as unknown as Config;
  for (const k of Object.keys(cfg.paths) as (keyof Config['paths'])[])
    if (k !== 'claude_project_slug') cfg.paths[k] = expandHome(cfg.paths[k]);
  cfg.integrations ??= {};
  cfg.polling ??= {};
  cfg.notifications ??= {};
  cfg.kpis ??= [];
  cfg.pricing ??= {};
  cfg.assistant.working_days ??= ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return cfg;
}

export function loadConfig(path = process.env.PAI_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`config not readable at ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ConfigError(`config YAML error: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}

export function levelOf(cfg: Config, cat: Category): Level {
  return cfg.approvals.levels[cat] ?? 'controlled';
}

/** Matches a whole ticket key of a configured tracker project, e.g. ACME-12. */
export const trackerKeyPattern = (cfg: Config): RegExp => new RegExp(`^(${cfg.tracker.projects.join('|')})-\\d+$`);

export function vaultFolder(cfg: Config, key: string): string {
  const f = cfg.vault.folders[key];
  if (!f) throw new ConfigError(`vault.folders.${key} is not configured`);
  return f;
}

export function repoForPath(cfg: Config, absPath: string): Repo | undefined {
  const hits = cfg.repositories.filter((r) => {
    const root = join(cfg.paths.workspace, r.path);
    return absPath === root || absPath.startsWith(root + '/') || absPath.startsWith(root + '-wt-');
  });
  return hits.sort((a, b) => b.path.length - a.path.length)[0];
}
