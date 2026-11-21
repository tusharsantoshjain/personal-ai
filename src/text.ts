import type { Config } from './config.ts';
import { findSecrets } from './secrets.ts';

/** GitHub state words for people: CHANGES_REQUESTED -> "changes requested". */
export const humanizeState = (state: string): string => state.toLowerCase().replace(/_/g, ' ');

export type Channel = 'chat' | 'github_comment' | 'tracker_comment' | 'commit' | 'email' | 'doc';
export interface Finding {
  rule: string;
  severity: 'error' | 'warn';
  message: string;
}

const FENCE = /^\s*(```|~~~)/;
const NON_PROSE = /^\s*([-*+] |\d+[.)] |#|>|\||<!--|\s{4,}\S)/;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Prose lines broken mid-sentence: the line has no closing punctuation and the next starts lowercase. */
export function hardWrappedLines(text: string): number[] {
  const lines = text.split('\n');
  const hits: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (FENCE.test(cur)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !cur.trim() || !next.trim() || NON_PROSE.test(cur) || NON_PROSE.test(next) || FENCE.test(next))
      continue;
    if (/^\S+:\s/.test(next) && /^[A-Z][\w-]*:/.test(next)) continue; // trailers like "Human-authored: x"
    if (cur.trimEnd().length >= 30 && !/[.!?:;)\]`"']$/.test(cur.trimEnd()) && /^[a-z(]/.test(next.trimStart()))
      hits.push(i + 1);
  }
  return hits;
}

export function lintText(cfg: Config, text: string, channel: Channel = 'chat'): Finding[] {
  const f: Finding[] = [];
  const lower = text.toLowerCase();
  for (const ch of cfg.writing.banned_chars)
    if (text.includes(ch))
      f.push({
        rule: 'dash',
        severity: 'error',
        message: `banned character U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}; use a comma, colon or full stop`,
      });
  for (const a of cfg.writing.ai_attribution)
    if (lower.includes(a.toLowerCase()))
      f.push({ rule: 'attribution', severity: 'error', message: `AI attribution "${a}"` });
  for (const s of findSecrets(text))
    f.push({ rule: 'secret', severity: 'error', message: `secret-shaped text (${s.kind})` });
  if (channel !== 'chat')
    for (const n of hardWrappedLines(text))
      f.push({
        rule: 'hardwrap',
        severity: 'error',
        message: `line ${n} is hard-wrapped prose; keep one line per paragraph`,
      });
  for (const p of cfg.writing.slop_phrases)
    if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
      f.push({ rule: 'slop', severity: 'warn', message: `generic phrasing "${p}"` });
  if (channel !== 'doc' && EMOJI.test(text))
    f.push({ rule: 'emoji', severity: 'warn', message: 'emoji in outgoing text' });
  const max = cfg.writing.max_chars[channel];
  if (max && text.length > max)
    f.push({ rule: 'length', severity: 'warn', message: `${text.length} chars, limit for ${channel} is ${max}` });
  return f;
}
