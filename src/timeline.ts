import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { readVaultFile, writeVaultFile, listNotes } from './vault.ts';

export const EVENT_TYPES = [
  'ticket-created',
  'ticket-resolved',
  'ticket-comment',
  'worklog',
  'pr-opened',
  'pr-merged',
  'pr-closed',
  'review-given',
  'review-received',
  'pr-comment',
  'decision',
  'pushback',
  'feedback',
  'meeting',
  'commitment',
  'note',
  'session',
  'session-result',
  'commits',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface TimelineEvent {
  ts: string; // "YYYY-MM-DD HH:mm" in the owner's timezone
  type: EventType;
  title: string;
  links: string[]; // note names, rendered as [[x]]
  src: string; // github | jira | session | owner | ...
  id: string; // stable block id, makes adds idempotent
}

const clean = (s: string) =>
  s
    .replace(/[\r\n|]+/g, ' ')
    .replace(/\s*[\u2014\u2013]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
export const blockId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export function formatEvent(e: TimelineEvent): string {
  const links = e.links.map((l) => `[[${l}]]`).join(' ');
  return `- ${e.ts} | ${e.type} | ${clean(e.title)} | ${links} | src: ${e.src} ^${blockId(e.id)}`;
}

const LINE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| ([a-z-]+) \| (.*?) \| (.*?) \| src: (\S+) \^(\S+)$/;
export function parseEvent(line: string): TimelineEvent | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  return {
    ts: m[1]!,
    type: m[2] as EventType,
    title: m[3]!,
    links: [...m[4]!.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]!),
    src: m[5]!,
    id: m[6]!,
  };
}

/** Format an instant as "YYYY-MM-DD HH:mm" in the configured timezone. */
export function localStamp(cfg: Config, d: Date | string = new Date()): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.assistant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD" in the configured timezone. */
export const localDay = (cfg: Config, d: Date | string = new Date()): string => localStamp(cfg, d).slice(0, 10);

/** Short weekday name ("Mon") in the configured timezone. */
export const localWeekday = (cfg: Config, d: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: cfg.assistant.timezone, weekday: 'short' }).format(d);

const monthFile = (cfg: Config, ts: string) => `${vaultFolder(cfg, 'timeline')}/${ts.slice(0, 7)}.md`;

/** Add events, skipping ids already present. Lines stay sorted by time inside each month file. Returns the count added. */
export function addEvents(cfg: Config, events: TimelineEvent[]): number {
  const unknown = events.find((e) => !EVENT_TYPES.includes(e.type));
  if (unknown) throw new Error(`unknown timeline event type: ${unknown.type}`);
  const byFile = Map.groupBy(events, (e) => monthFile(cfg, e.ts));
  let added = 0;
  for (const [file, evs] of byFile) {
    const text =
      readVaultFile(cfg.paths.vault, file) ??
      `---\ntype: timeline\nmonth: "${evs[0]!.ts.slice(0, 7)}"\n---\n# Timeline ${evs[0]!.ts.slice(0, 7)}\n\n`;
    const lines = text.split('\n');
    const ids = new Set(lines.map((l) => /\^(\S+)$/.exec(l)?.[1]).filter(Boolean));
    const fresh = evs.filter((e) => {
      const id = blockId(e.id);
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    if (!fresh.length) continue;
    const head = lines.filter((l) => !parseEvent(l));
    const all = [...lines.filter((l) => parseEvent(l)), ...fresh.map(formatEvent)].sort((a, b) =>
      a.slice(2, 18).localeCompare(b.slice(2, 18)),
    );
    while (head.length && head[head.length - 1] === '') head.pop();
    writeVaultFile(cfg.paths.vault, file, `${head.join('\n')}\n\n${all.join('\n')}\n`);
    added += fresh.length;
  }
  return added;
}

export function readEvents(
  cfg: Config,
  opts: { sinceDays?: number; entity?: string; type?: string; now?: Date } = {},
): TimelineEvent[] {
  const folder = vaultFolder(cfg, 'timeline');
  const files = listNotes(cfg.paths.vault).filter((f) => f.startsWith(folder + '/') && /\/\d{4}-\d{2}\.md$/.test(f));
  const cutoff =
    opts.sinceDays !== undefined
      ? localStamp(cfg, new Date((opts.now ?? new Date()).getTime() - opts.sinceDays * 86400_000))
      : '';
  const out: TimelineEvent[] = [];
  for (const f of files) {
    for (const line of (readVaultFile(cfg.paths.vault, f) ?? '').split('\n')) {
      const e = parseEvent(line);
      if (!e || e.ts < cutoff) continue;
      if (opts.type && e.type !== opts.type) continue;
      if (
        opts.entity &&
        !e.links.some((l) => l.toLowerCase() === opts.entity!.toLowerCase()) &&
        !e.title.toLowerCase().includes(opts.entity.toLowerCase())
      )
        continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
