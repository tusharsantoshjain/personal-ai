import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic } from './files.ts';
import type { Config } from './config.ts';
import { loadConfig, REPO_ROOT } from './config.ts';
import { classify, decide, type ClassifyOptions, type Decision, type Hit, type HookInput } from './gate/index.ts';
import { maskSecrets } from './secrets.ts';
import { sessionBrief } from './brief.ts';

const GRANT_TTL_MS = 15 * 60_000;
const SESSION_GRANT_TTL_MS = 8 * 3600_000;
const AGENT_TTL_MS = 2 * 3600_000;

const approvalsDir = (cfg: Config) => join(cfg.paths.cache_dir, 'approvals');
const stateDir = (cfg: Config) => join(cfg.paths.cache_dir, 'state');

// An approval that offered "for the session" remembers which file it was about, so the answer cannot name another.
const pendingScopeFile = (cfg: Config, approvalKey: string) => join(approvalsDir(cfg), `pending-${approvalKey}.json`);
const scopeGrantFile = (cfg: Config, scopeKey: string) => join(approvalsDir(cfg), `scope-${scopeKey}.json`);

/** True while the owner's "approve this file for the session" stands. Not consumed by use. */
export function hasSessionGrant(cfg: Config, scopeKey: string): boolean {
  const grantedAt = readJson<{ ts?: number }>(scopeGrantFile(cfg, scopeKey), {}).ts;
  return grantedAt !== undefined && Date.now() - grantedAt < SESSION_GRANT_TTL_MS;
}

/** One-time grant: true and consumed when the owner approved this exact call recently. */
export function consumeGrant(cfg: Config, key: string): boolean {
  const grantFile = join(approvalsDir(cfg), `${key}.json`);
  if (!existsSync(grantFile)) return false;
  const grantedAt = readJson<{ ts?: number }>(grantFile, {}).ts;
  rmSync(grantFile, { force: true });
  return grantedAt !== undefined && Date.now() - grantedAt < GRANT_TTL_MS;
}

/** PostToolUse on AskUserQuestion: turn an "Approve" answer to an [approval:key] question into a grant. */
export function recordAnswers(cfg: Config, input: HookInput): string[] {
  const qs = (input.tool_input.questions as { question?: string }[] | undefined) ?? [];
  const resp = input.tool_response;
  const respText = typeof resp === 'string' ? resp : JSON.stringify(resp ?? '');
  const answers =
    (resp && typeof resp === 'object' && 'answers' in resp
      ? (resp as { answers: Record<string, unknown> }).answers
      : undefined) ??
    (input.tool_input.answers as Record<string, unknown> | undefined) ??
    {};
  const granted: string[] = [];
  for (const q of qs) {
    const text = q.question ?? '';
    const key = /\[approval:([0-9a-f]{12})\]/.exec(text)?.[1];
    if (!key) continue;
    let answer = typeof answers[text] === 'string' ? (answers[text] as string) : '';
    if (!answer) {
      // String form: `"<question>"="<answer>"`, possibly JSON-escaped once.
      for (const form of [text, JSON.stringify(text).slice(1, -1)]) {
        const i = respText.indexOf(form);
        if (i < 0) continue;
        answer = /^\\?"\s*[=:]\s*\\?"([^"\\]*)/.exec(respText.slice(i + form.length))?.[1] ?? '';
        if (answer) break;
      }
    }
    const pendingScope = readJson<{ key?: string }>(pendingScopeFile(cfg, key), {}).key;
    rmSync(pendingScopeFile(cfg, key), { force: true });
    if (/^approve\b/i.test(answer.trim())) {
      const grant = JSON.stringify({ ts: Date.now(), session: input.session_id ?? '' });
      writeFileAtomic(join(approvalsDir(cfg), `${key}.json`), grant);
      if (pendingScope && /\bsession\b/i.test(answer)) writeFileAtomic(scopeGrantFile(cfg, pendingScope), grant);
      granted.push(key);
    }
  }
  return granted;
}

interface AgentState {
  running: { ts: number; key: string }[];
}
const agentFile = (cfg: Config, session: string) =>
  join(stateDir(cfg), `agents-${session.replace(/[^\w-]/g, '') || 'default'}.json`);

function loadAgents(cfg: Config, session: string): AgentState {
  const running = readJson<Partial<AgentState>>(agentFile(cfg, session), {}).running ?? [];
  return { running: running.filter((agent) => Date.now() - agent.ts < AGENT_TTL_MS) };
}

export function agentStarted(cfg: Config, session: string, key: string) {
  const s = loadAgents(cfg, session);
  s.running.push({ ts: Date.now(), key });
  writeFileAtomic(agentFile(cfg, session), JSON.stringify(s));
}

export function agentStopped(cfg: Config, session: string) {
  const s = loadAgents(cfg, session);
  s.running.shift();
  writeFileAtomic(agentFile(cfg, session), JSON.stringify(s));
}

export function resetAgents(cfg: Config) {
  if (!existsSync(stateDir(cfg))) return 0;
  const files = readdirSync(stateDir(cfg)).filter((f) => f.startsWith('agents-'));
  for (const f of files) rmSync(join(stateDir(cfg), f), { force: true });
  return files.length;
}

export function runningAgents(cfg: Config, session: string) {
  return loadAgents(cfg, session).running.length;
}

function shortCall(input: HookInput): string {
  const ti = input.tool_input ?? {};
  const s =
    typeof ti.command === 'string' ? ti.command : typeof ti.file_path === 'string' ? ti.file_path : JSON.stringify(ti);
  return maskSecrets(s.replace(/\s+/g, ' ')).slice(0, 200);
}

export function log(cfg: Config | undefined, entry: Record<string, unknown>) {
  try {
    const dir = cfg?.paths.logs_dir ?? process.env.PAI_LOGS_DIR ?? join(REPO_ROOT, 'logs'); // no config: tests and doctor point PAI_LOGS_DIR elsewhere
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hooks.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging must never break the gate */
  }
}

const out = (decision: 'allow' | 'deny' | 'ask', reason: string) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  });

/** PreToolUse: returns the JSON to print, or '' to let the call pass to normal permissions. */
export function preToolUse(
  cfg: Config,
  input: HookInput,
  opts: ClassifyOptions = {},
): { output: string; decision: Decision; hits: Hit[] } {
  const hits = classify(cfg, input, opts);
  const isAgent = input.tool_name === 'Agent' || input.tool_name === 'Task';
  const session = input.session_id ?? 'default';
  if (isAgent) {
    const running = runningAgents(cfg, session);
    if (running >= cfg.assistant.max_parallel_agents)
      hits.push({
        cat: 'agent_cap',
        why: `${running} agents already running (max ${cfg.assistant.max_parallel_agents}); wait for one to finish, run in waves`,
      });
  }
  const decision = decide(
    cfg,
    input,
    hits,
    (key) => consumeGrant(cfg, key),
    (scopeKey) => hasSessionGrant(cfg, scopeKey),
  );
  if (decision.kind === 'approval' && decision.scope)
    writeFileAtomic(pendingScopeFile(cfg, decision.key), JSON.stringify(decision.scope));
  if (isAgent && (decision.kind === 'pass' || decision.kind === 'allow'))
    agentStarted(cfg, session, String(input.tool_input.description ?? ''));
  if (decision.kind !== 'pass')
    log(cfg, {
      session,
      agent: input.agent_id ?? '',
      tool: input.tool_name,
      decision: decision.kind,
      key: 'key' in decision ? decision.key : '',
      cats: [...new Set(hits.map((h) => h.cat))],
      call: shortCall(input),
    });
  switch (decision.kind) {
    case 'pass':
      return { output: '', decision, hits };
    case 'allow':
      return { output: out('allow', decision.reason), decision, hits };
    case 'ask':
      return { output: out('ask', decision.reason), decision, hits };
    default:
      return { output: out('deny', decision.reason), decision, hits };
  }
}

/** Entry for every hook event. Never throws: PreToolUse fails closed (ask), other events fail open. */
export function handle(raw: string, opts: ClassifyOptions & { configPath?: string } = {}): string {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (e) {
    log(undefined, { decision: 'ask', error: `bad hook input: ${(e as Error).message}` });
    return out('ask', 'Gate could not read the hook input; asking instead (fail closed).');
  }
  const event = input.hook_event_name ?? 'PreToolUse';
  let cfg: Config;
  try {
    cfg = loadConfig(opts.configPath);
  } catch (e) {
    log(undefined, { decision: 'ask', event, error: (e as Error).message });
    if (event === 'PreToolUse')
      return out(
        'ask',
        `Assistant config is invalid, so every gated call asks: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`,
      );
    if (event === 'SessionStart')
      return `AURA: config invalid, run \`pai doctor\`. ${(e as Error).message.split('\n')[0]}`;
    return '';
  }
  try {
    input.tool_input ??= {};
    if (event === 'PreToolUse') return preToolUse(cfg, input, opts).output;
    if (event === 'PostToolUse' && input.tool_name === 'AskUserQuestion') {
      const g = recordAnswers(cfg, input);
      if (g.length) log(cfg, { decision: 'granted', keys: g, session: input.session_id });
      return '';
    }
    if (event === 'SubagentStop') {
      agentStopped(cfg, input.session_id ?? 'default');
      return '';
    }
    if (event === 'SessionStart') return sessionBrief(cfg);
    return '';
  } catch (e) {
    log(cfg, { decision: 'ask', event, error: (e as Error).stack?.split('\n').slice(0, 3).join(' | ') });
    return event === 'PreToolUse'
      ? out('ask', `Gate error, asking instead (fail closed): ${(e as Error).message}`)
      : '';
  }
}
