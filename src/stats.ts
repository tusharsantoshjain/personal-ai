import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { listTranscripts, parseTranscript, type Usage } from './transcripts.ts';

export interface Stats {
  days: number;
  sessions: number;
  subagentTranscripts: number;
  tokens: Record<string, Usage>;
  cacheHitRate: number;
  agentRuns: Record<string, number>;
  approvalsAsked: number;
  denied: number;
  /** Gate categories behind those approvals and denials, with counts. */
  askedBy: Record<string, number>;
  deniedBy: Record<string, number>;
  prsCreated: number;
  toolUses: number;
  failedToolCalls: number;
  avgSessionMinutes: number;
  cost?: number;
}

const family = (model: string) =>
  /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : model;

export function computeStats(cfg: Config, days: number, now = Date.now()): Stats {
  const cutoff = now - days * 86400_000;
  const st: Stats = {
    days,
    sessions: 0,
    subagentTranscripts: 0,
    tokens: {},
    cacheHitRate: 0,
    agentRuns: {},
    approvalsAsked: 0,
    denied: 0,
    askedBy: {},
    deniedBy: {},
    prsCreated: 0,
    toolUses: 0,
    failedToolCalls: 0,
    avgSessionMinutes: 0,
  };
  let minutes = 0;
  for (const t of listTranscripts(cfg.paths.claude_projects, cutoff)) {
    const s = parseTranscript(t.file, t.project, t.subagent);
    if (!s || Date.parse(s.end) < cutoff) continue;
    if (t.subagent) st.subagentTranscripts++;
    else {
      st.sessions++;
      minutes += (Date.parse(s.end) - Date.parse(s.start)) / 60_000;
    }
    for (const [m, u] of Object.entries(s.tokens)) {
      const f = family(m);
      const acc = (st.tokens[f] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      acc.input += u.input;
      acc.output += u.output;
      acc.cacheRead += u.cacheRead;
      acc.cacheWrite += u.cacheWrite;
    }
    for (const [k, v] of Object.entries(s.agentRuns)) st.agentRuns[k] = (st.agentRuns[k] ?? 0) + v;
    st.prsCreated += s.prCreates;
    st.toolUses += s.toolUses;
    st.failedToolCalls += s.toolErrors;
  }
  const all = Object.values(st.tokens);
  const read = all.reduce((a, u) => a + u.cacheRead, 0);
  const totalIn = all.reduce((a, u) => a + u.input + u.cacheRead + u.cacheWrite, 0);
  st.cacheHitRate = totalIn ? read / totalIn : 0;
  st.avgSessionMinutes = st.sessions ? Math.round(minutes / st.sessions) : 0;
  const logFile = join(cfg.paths.logs_dir, 'hooks.jsonl');
  if (existsSync(logFile))
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line) as { ts: string; decision: string; session?: string; cats?: string[] };
        if (Date.parse(e.ts) < cutoff || e.session === 'doctor') continue;
        const asked = e.decision === 'approval' || e.decision === 'ask';
        if (asked) st.approvalsAsked++;
        if (e.decision === 'deny') st.denied++;
        const byCategory = asked ? st.askedBy : e.decision === 'deny' ? st.deniedBy : undefined;
        if (byCategory) for (const category of e.cats ?? []) byCategory[category] = (byCategory[category] ?? 0) + 1;
      } catch {
        /* skip */
      }
    }
  if (Object.keys(cfg.pricing).length) {
    st.cost = Object.entries(st.tokens).reduce((sum, [f, u]) => {
      const p = cfg.pricing[f];
      if (!p) return sum;
      return (
        sum +
        (u.input * p.input +
          u.output * p.output +
          u.cacheRead * (p.cache_read ?? p.input) +
          u.cacheWrite * (p.cache_write ?? p.input)) /
          1e6
      );
    }, 0);
  }
  return st;
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

const topCategories = (counts: Record<string, number>, limit = 5) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([category, n]) => `${category} ${n}`)
    .join(', ');

export function formatStats(st: Stats): string {
  const lines = [
    `Last ${st.days} days: ${st.sessions} sessions (avg ${st.avgSessionMinutes} min), ${st.subagentTranscripts} subagent transcripts, ${st.toolUses} tool calls, ${st.failedToolCalls} failed.`,
  ];
  for (const [f, u] of Object.entries(st.tokens).sort())
    lines.push(
      `- ${f}: in ${k(u.input)}, out ${k(u.output)}, cache read ${k(u.cacheRead)}, cache write ${k(u.cacheWrite)}`,
    );
  lines.push(`Cache hit rate: ${(st.cacheHitRate * 100).toFixed(0)}%`);
  const agents = Object.entries(st.agentRuns).sort((a, b) => b[1] - a[1]);
  lines.push(
    `Agent runs: ${agents.reduce((a, [, n]) => a + n, 0)}${agents.length ? ` (${agents.map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}`,
  );
  lines.push(`Approvals asked: ${st.approvalsAsked}, denied by policy: ${st.denied}, PRs created: ${st.prsCreated}`);
  if (st.approvalsAsked) lines.push(`Most asked: ${topCategories(st.askedBy)}`);
  if (st.denied) lines.push(`Most denied: ${topCategories(st.deniedBy)}`);
  lines.push(
    st.cost !== undefined
      ? `Estimated API-equivalent cost: $${st.cost.toFixed(2)}`
      : 'Cost: not estimated (no pricing in config).',
  );
  return lines.join('\n');
}
