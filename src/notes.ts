import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { addEvents, type EventType, localStamp } from './timeline.ts';
import { appendLineToNote, listNotes, parseNote, readVaultFile, safeFileName, stubNote } from './vault.ts';

export interface IndexEntry {
  path: string;
  title: string;
  type: string;
  aliases: string[];
}

// ponytail: index rebuilt on every call by reading all notes; cache it if the vault grows past ~10k notes.
export function buildIndex(cfg: Config): IndexEntry[] {
  return listNotes(cfg.paths.vault, ['.obsidian']).map((path) => {
    const { data } = parseNote(readVaultFile(cfg.paths.vault, path) ?? '');
    const aliases = Array.isArray(data.aliases)
      ? data.aliases.map(String)
      : typeof data.aliases === 'string'
        ? [data.aliases]
        : [];
    return {
      path,
      title: path.split('/').pop()!.replace(/\.md$/, ''),
      type: typeof data.type === 'string' ? data.type : '',
      aliases,
    };
  });
}

export interface FindHit {
  path: string;
  score: number;
  snippet: string;
}

export function find(cfg: Config, query: string, limit = 10): FindHit[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const hits: FindHit[] = [];
  for (const e of buildIndex(cfg)) {
    const title = e.title.toLowerCase();
    const aliases = e.aliases.map((a) => a.toLowerCase());
    let score = 0;
    if (title === q) score += 100;
    else if (aliases.includes(q)) score += 90;
    else if (title.includes(q)) score += 50;
    else if (aliases.some((a) => a.includes(q))) score += 40;
    const body = readVaultFile(cfg.paths.vault, e.path) ?? '';
    const lower = body.toLowerCase();
    const termHits = terms.filter((t) => lower.includes(t)).length;
    if (termHits === terms.length) score += 10 + Math.min(10, lower.split(terms[0]!).length - 1);
    if (!score) continue;
    const line = body.split('\n').find((l) => l.toLowerCase().includes(terms[0]!)) ?? '';
    hits.push({ path: e.path, score, snippet: line.trim().slice(0, 160) });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Canonical name for a person or note: config aliases first, then note titles and aliases (case-insensitive). */
export function resolve(cfg: Config, name: string): { name: string; path?: string } | undefined {
  const n = name
    .trim()
    .replace(/^@/, '')
    .replace(/^\[\[|\]\]$/g, '');
  const lower = n.toLowerCase();
  const alias = Object.entries(cfg.people.aliases).find(([k]) => k.toLowerCase() === lower)?.[1];
  const target = (alias ?? n).toLowerCase();
  const idx = buildIndex(cfg);
  const hit =
    idx.find((e) => e.title.toLowerCase() === target) ??
    idx.find((e) => e.aliases.some((a) => a.toLowerCase() === target || a.toLowerCase() === lower));
  if (hit) return { name: hit.title, path: hit.path };
  if (alias) return { name: alias };
  return undefined;
}

export const RECORD_KINDS = [
  'decision',
  'pushback',
  'review-given',
  'review-received',
  'feedback',
  'note',
  'commitment',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const REPO_PR = /^([\w.-]+)#(\d+)$/;

/** Map a --on target to a note path and display name, creating ticket and PR stubs when missing. */
function targetNote(cfg: Config, target: string): { name: string; path: string; create?: Record<string, unknown> } {
  if (TICKET.test(target))
    return {
      name: target,
      path: `${vaultFolder(cfg, 'tracker')}/${target}.md`,
      create: { type: 'ticket', key: target, status: 'TBD' },
    };
  const pr = REPO_PR.exec(target);
  if (pr) {
    const name = `PR-${pr[1]}-${pr[2]}`;
    return {
      name,
      path: `${vaultFolder(cfg, 'prs')}/${name}.md`,
      create: { type: 'pr', repo: `[[${pr[1]}]]`, number: Number(pr[2]), status: 'TBD' },
    };
  }
  const r = resolve(cfg, target);
  if (r?.path) return { name: r.name, path: r.path };
  throw new Error(
    `target not found: "${target}". Run \`pai find ${target}\` and pass an existing note, a ticket key or repo#number.`,
  );
}

function personNote(cfg: Config, person: string): { name: string; path: string } {
  const r = resolve(cfg, person);
  const name = r?.name ?? person.trim();
  return { name, path: r?.path ?? `${vaultFolder(cfg, 'people')}/${safeFileName(name)}.md` };
}

export interface RecordResult {
  written: string[];
  timelineAdded: number;
}

/** Record a decision, pushback, review, feedback or note. Idempotent: same input on the same day changes nothing. */
export function record(cfg: Config, kind: RecordKind, text: string, on: string[], withPeople: string[]): RecordResult {
  if (!RECORD_KINDS.includes(kind)) throw new Error(`unknown record kind: ${kind}`);
  const body = text.replace(/\s+/g, ' ').trim();
  if (!body) throw new Error('record text is empty');
  for (const ch of cfg.writing.banned_chars)
    if (body.includes(ch)) throw new Error('record text contains a banned dash character');
  const stamp = localStamp(cfg);
  const day = stamp.slice(0, 10);
  const targets = on.map((t) => targetNote(cfg, t));
  const people = withPeople.map((p) => personNote(cfg, p));
  const written: string[] = [];

  const vault = cfg.paths.vault;
  const withPart = people.length ? ` (with ${people.map((p) => `[[${p.name}]]`).join(', ')})` : '';
  for (const t of targets) {
    if (
      appendLineToNote(vault, t.path, 'Log', `- ${day} ${kind}: ${body}${withPart}`, day, () =>
        stubNote(t.name, t.create ?? {}, day),
      )
    )
      written.push(t.path);
  }
  const onPart = targets.length ? ` (on ${targets.map((t) => `[[${t.name}]]`).join(', ')})` : '';
  for (const p of people) {
    if (
      appendLineToNote(vault, p.path, 'History', `- ${day} ${kind}: ${body}${onPart}`, day, () =>
        stubNote(p.name, { type: 'person', aliases: [], role: 'TBD', team: 'TBD' }, day),
      )
    )
      written.push(p.path);
  }
  const id = createHash('sha1')
    .update([kind, body, day, ...on, ...withPeople].join('|'))
    .digest('hex')
    .slice(0, 12);
  const type: EventType = kind;
  const timelineAdded = addEvents(cfg, [
    {
      ts: stamp,
      type,
      title: body,
      links: [...targets.map((t) => t.name), ...people.map((p) => p.name)],
      src: 'owner',
      id: `rec-${id}`,
    },
  ]);
  return { written, timelineAdded };
}
