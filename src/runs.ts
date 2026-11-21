import type { Config } from './config.ts';
import { localDay, localStamp } from './timeline.ts';
import {
  appendToSection,
  parseNote,
  readNotesIn,
  readVaultFile,
  renderNote,
  safeFileName,
  writeVaultFile,
} from './vault.ts';

export interface RunData {
  type: 'run';
  skill: string;
  status: 'active' | 'blocked' | 'done' | 'failed' | 'abandoned';
  created: string;
  updated: string;
  project: string;
  repo: string;
  ticket: string;
  pr: string;
  agents: string[];
  current_step: string;
  completed_steps: string[];
  failed_steps: string[];
  validation: string;
  approval_required: boolean;
  approval_status: string;
  branch: string;
  worktree: string;
  artifacts: string[];
  memory_updates: string[];
}

const runPath = (cfg: Config, name: string) => `${cfg.vault.runs_folder}/${name}.md`;

export function runName(cfg: Config, skill: string, ticket: string): string {
  return safeFileName(`${localDay(cfg)}-${skill}-${ticket || 'adhoc'}`);
}

export function startRun(cfg: Config, skill: string, ticket: string, extra: Partial<RunData> = {}): string {
  const name = runName(cfg, skill, ticket);
  if (readVaultFile(cfg.paths.vault, runPath(cfg, name))) return name; // resume, never duplicate
  const data: RunData = {
    type: 'run',
    skill,
    status: 'active',
    created: localDay(cfg),
    updated: localDay(cfg),
    project: '',
    repo: '',
    ticket: ticket ? `[[${ticket}]]` : '',
    pr: '',
    agents: [],
    current_step: 'intake',
    completed_steps: [],
    failed_steps: [],
    validation: '',
    approval_required: false,
    approval_status: '',
    branch: '',
    worktree: '',
    artifacts: [],
    memory_updates: [],
    ...extra,
  };
  writeVaultFile(
    cfg.paths.vault,
    runPath(cfg, name),
    renderNote({
      data: data as unknown as Record<string, unknown>,
      body: `## Steps\n- ${localStamp(cfg)} start: ${skill}\n`,
    }),
  );
  return name;
}

function load(cfg: Config, name: string) {
  const text = readVaultFile(cfg.paths.vault, runPath(cfg, name));
  if (!text) throw new Error(`run not found: ${name}`);
  return parseNote(text);
}

/**
 * Record a step outcome. `done` moves the step to completed and sets the next step;
 * `failed` keeps current_step on the failed step so a resume starts there.
 */
export function stepRun(
  cfg: Config,
  name: string,
  step: string,
  outcome: 'done' | 'failed' | 'started',
  note = '',
  next?: string,
): void {
  const n = load(cfg, name);
  const d = n.data as unknown as RunData;
  const uniq = (xs: string[], x: string) => (xs.includes(x) ? xs : [...xs, x]);
  if (outcome === 'done') {
    d.completed_steps = uniq(d.completed_steps ?? [], step);
    d.failed_steps = (d.failed_steps ?? []).filter((s) => s !== step);
    d.current_step = next ?? d.current_step;
  } else if (outcome === 'failed') {
    d.failed_steps = uniq(d.failed_steps ?? [], step);
    d.current_step = step;
  } else d.current_step = step;
  d.updated = localDay(cfg);
  n.body = appendToSection(n.body, 'Steps', `- ${localStamp(cfg)} ${step} ${outcome}${note ? `: ${note}` : ''}`);
  writeVaultFile(cfg.paths.vault, runPath(cfg, name), renderNote(n));
}

const SETTABLE = new Set([
  'status',
  'project',
  'repo',
  'ticket',
  'pr',
  'validation',
  'approval_required',
  'approval_status',
  'branch',
  'worktree',
  'current_step',
  'agents',
  'artifacts',
  'memory_updates',
]);
const LISTS = new Set(['agents', 'artifacts', 'memory_updates']);

export function setRun(cfg: Config, name: string, key: string, value: string): void {
  if (!SETTABLE.has(key)) throw new Error(`run field not settable: ${key}`);
  const n = load(cfg, name);
  const d = n.data as Record<string, unknown>;
  if (LISTS.has(key)) d[key] = [...new Set([...((d[key] as string[]) ?? []), value])];
  else if (key === 'approval_required') d[key] = value === 'true';
  else d[key] = value;
  d.updated = localDay(cfg);
  writeVaultFile(cfg.paths.vault, runPath(cfg, name), renderNote(n));
}

export function listRuns(cfg: Config, opts: { open?: boolean } = {}): { name: string; data: RunData }[] {
  return readNotesIn(cfg.paths.vault, cfg.vault.runs_folder)
    .map((note) => ({ name: note.name, data: note.data as unknown as RunData }))
    .filter((r) => r.data.type === 'run' && (!opts.open || r.data.status === 'active' || r.data.status === 'blocked'));
}

export function showRun(cfg: Config, name: string): string {
  return readVaultFile(cfg.paths.vault, runPath(cfg, name)) ?? `run not found: ${name}`;
}
