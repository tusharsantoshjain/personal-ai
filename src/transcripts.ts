import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface SessionSummary {
  id: string;
  project: string;
  file: string;
  cwd: string;
  branch: string;
  start: string;
  end: string;
  prompts: string[]; // what the owner typed
  results: { ts: string; text: string }[]; // `result:` lines the assistant ended its answers with
  tokens: Record<string, Usage>;
  agentRuns: Record<string, number>;
  toolUses: number;
  toolErrors: number;
  prCreates: number;
  subagent: boolean;
}

const NOISE = /^(<command-|<local-command|<system-reminder|<bash-|<task-notification|Caveat:|\[Request interrupted)/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((c) => (c as { type?: string }).type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  return '';
}

export function parseTranscript(file: string, project: string, subagent = false): SessionSummary | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const s: SessionSummary = {
    id: basename(file, '.jsonl'),
    project,
    file,
    cwd: '',
    branch: '',
    start: '',
    end: '',
    prompts: [],
    results: [],
    tokens: {},
    agentRuns: {},
    toolUses: 0,
    toolErrors: 0,
    prCreates: 0,
    subagent,
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof e.timestamp === 'string' ? e.timestamp : '';
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts;
      if (ts > s.end) s.end = ts;
    }
    if (typeof e.sessionId === 'string' && !subagent) s.id = e.sessionId;
    if (typeof e.cwd === 'string' && !s.cwd) s.cwd = e.cwd;
    if (typeof e.gitBranch === 'string' && e.gitBranch) s.branch = e.gitBranch;
    const msg = e.message as
      { role?: string; content?: unknown; model?: string; usage?: Record<string, number> } | undefined;
    if (!msg) continue;
    if (e.type === 'user') {
      const parts = Array.isArray(msg.content) ? (msg.content as { type?: string; is_error?: boolean }[]) : undefined;
      for (const c of parts ?? []) if (c.type === 'tool_result' && c.is_error) s.toolErrors++;
      const isToolResult = parts?.some((c) => c.type === 'tool_result') ?? false;
      const t = textOf(msg.content).trim();
      if (msg.role === 'user' && !e.isMeta && !e.isSidechain && !subagent && t && !isToolResult && !NOISE.test(t))
        s.prompts.push(t);
    }
    if (e.type === 'assistant') {
      const model = msg.model ?? 'unknown';
      if (msg.usage && model !== '<synthetic>') {
        const u = (s.tokens[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        u.input += msg.usage.input_tokens ?? 0;
        u.output += msg.usage.output_tokens ?? 0;
        u.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
        u.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
      }
      if (!e.isSidechain && !subagent)
        for (const l of textOf(msg.content).split('\n')) {
          const m = /^\s*result:\s*(.+)$/.exec(l);
          if (m) s.results.push({ ts, text: m[1]!.trim() });
        }
      if (Array.isArray(msg.content))
        for (const c of msg.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
          if (c.type !== 'tool_use') continue;
          s.toolUses++;
          if (c.name === 'Agent' || c.name === 'Task') {
            const t = String(c.input?.subagent_type ?? 'general-purpose');
            s.agentRuns[t] = (s.agentRuns[t] ?? 0) + 1;
          }
          if (c.name === 'Bash' && /\bgh\s+pr\s+create\b/.test(String(c.input?.command ?? ''))) s.prCreates++;
        }
    }
  }
  return s.start ? s : undefined;
}

/** All transcripts under the Claude projects folder. Top-level files are sessions; nested ones are subagents. */
export function listTranscripts(
  projectsDir: string,
  sinceMs = 0,
): { file: string; project: string; subagent: boolean }[] {
  const out: { file: string; project: string; subagent: boolean }[] = [];
  if (!existsSync(projectsDir)) return out;
  const walk = (dir: string, project: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== 'memory') walk(p, project, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= sinceMs)
        out.push({ file: p, project, subagent: depth > 0 });
    }
  };
  for (const d of readdirSync(projectsDir, { withFileTypes: true }))
    if (d.isDirectory()) walk(join(projectsDir, d.name), d.name, 0);
  return out;
}
