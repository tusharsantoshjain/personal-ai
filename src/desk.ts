import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { loadSnapshot, ticketsIn, type PrState } from './prs.ts';
import { listRuns } from './runs.ts';
import { missedRuns, type RoutineName } from './schedule.ts';
import type { Tone } from './style.ts';
import { localDay, localStamp, localWeekday, readEvents, type TimelineEvent } from './timeline.ts';
import { parseNote, readNotesIn, readVaultFile } from './vault.ts';

export interface Badge {
  text: string;
  tone: Tone;
}

/** A PR with what the desk pane and `pai dash` draw: how urgent it is and its facts as short labels. */
export interface DeskPr extends PrState {
  tone: Tone;
  badges: Badge[];
}

export interface DeskSummary {
  all: number;
  action: number;
  drafts: number;
  approved: number;
  failing: number;
  reviews: number;
}

export interface DeskData {
  generated: string;
  snapshotAt: string;
  /** Age of the PR data in words, and whether it is old enough to point out. */
  snapshot: { text: string; stale: boolean };
  summary: DeskSummary;
  /** Installed routines that did not run when they were last due. */
  missedRoutines: RoutineName[];
  groups: { ticket: string; prs: DeskPr[] }[];
  reviews: DeskPr[];
  runs: { name: string; status: string; step: string; pr: string }[];
  tickets: OpenTicket[];
  sessions: Record<string, string>; // ticket or branch -> latest Claude session id
  standupTime: string | null;
  timezone: string;
  isWorkingDay: boolean;
}

export function prTone(pr: PrState): Tone {
  if (pr.ci === 'fail' || pr.conflicts) return 'bad';
  if (pr.needs.length) return 'warn';
  if (pr.review === 'APPROVED') return 'good';
  return 'idle';
}

const CI_BADGE: Record<PrState['ci'], Badge | null> = {
  pass: { text: 'CI passing', tone: 'good' },
  fail: { text: 'CI failing', tone: 'bad' },
  pending: { text: 'CI running', tone: 'warn' },
  none: null,
};
const REVIEW_BADGE: Record<string, Badge> = {
  APPROVED: { text: 'approved', tone: 'good' },
  CHANGES_REQUESTED: { text: 'changes requested', tone: 'warn' },
  REVIEW_REQUIRED: { text: 'awaiting review', tone: 'idle' },
};
const QUIET_AFTER_DAYS = 3;

/** The facts about a PR as short labels, most telling first. */
export function prBadges(pr: PrState): Badge[] {
  const badges: Badge[] = [];
  if (pr.draft) badges.push({ text: 'draft', tone: 'idle' });
  const ci = CI_BADGE[pr.ci];
  if (ci) badges.push(ci);
  badges.push(REVIEW_BADGE[pr.review] ?? { text: 'no review yet', tone: 'idle' });
  if (pr.conflicts) badges.push({ text: 'merge conflict', tone: 'bad' });
  if (pr.unresolved) badges.push({ text: `${pr.unresolved} unresolved`, tone: 'warn' });
  if (pr.staleDays >= QUIET_AFTER_DAYS) badges.push({ text: `quiet ${pr.staleDays}d`, tone: 'idle' });
  return badges;
}

const toDeskPr = (pr: PrState): DeskPr => ({ ...pr, tone: prTone(pr), badges: prBadges(pr) });

const STALE_AFTER_HOURS = 4;

/** How old the PR snapshot is, in words. */
export function snapshotAge(snapshotAt: string, now: Date): DeskData['snapshot'] {
  if (!snapshotAt) return { text: 'no PR data yet (run `pai prs`)', stale: true };
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(snapshotAt)) / 60_000));
  const age =
    minutes < 2
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h ago`
          : `${Math.round(minutes / 1440)} d ago`;
  return { text: `PR data ${age}`, stale: minutes >= STALE_AFTER_HOURS * 60 };
}

const DONE_STATUS = /^(done|closed|resolved|released|cancel+ed|won'?t do|duplicate)$/i;

export interface OpenTicket {
  key: string;
  status: string;
  summary: string;
}

/** Ticket notes assigned to the owner that are not done. Shared by the desk pane and Now.md. */
export function myOpenTickets(cfg: Config): OpenTicket[] {
  return readNotesIn(cfg.paths.vault, vaultFolder(cfg, 'tracker'))
    .map((note) => note.data)
    .filter(
      (d) =>
        d.type === 'ticket' &&
        String(d.assignee ?? '') === `[[${cfg.people.self}]]` &&
        !DONE_STATUS.test(String(d.status ?? '')),
    )
    .map((d) => ({ key: String(d.key), status: String(d.status), summary: String(d.summary ?? '') }));
}

/** Everything the desk pane shows, from local state only (PR snapshot, runs, tracker notes, timeline). */
export function deskData(cfg: Config, now = new Date()): DeskData {
  const snap = loadSnapshot(cfg);
  const mine = (snap?.prs.filter((p) => p.role === 'author') ?? []).map(toDeskPr);
  const reviews = (snap?.prs.filter((p) => p.role === 'reviewer') ?? []).map(toDeskPr);
  const groups = [...Map.groupBy(mine, (p) => p.tickets[0] ?? 'No ticket')]
    .map(([ticket, prs]) => ({ ticket, prs: prs.sort((a, b) => b.needs.length - a.needs.length) }))
    .sort(
      (a, b) =>
        (b.prs.some((p) => p.needs.length) ? 1 : 0) - (a.prs.some((p) => p.needs.length) ? 1 : 0) ||
        a.ticket.localeCompare(b.ticket),
    );

  const tickets = myOpenTickets(cfg);

  // Latest session per ticket key or branch, from session events ("repo (branch): prompt" with ticket links).
  const sessions: Record<string, string> = {};
  for (const e of readEvents(cfg, { sinceDays: 120, type: 'session', now })) {
    const id = e.id.replace(/^session-/, '');
    for (const t of e.links) sessions[t] = id;
    const branch = /\(([^)]+)\):/.exec(e.title)?.[1];
    if (branch && branch !== 'HEAD') sessions[branch] = id;
  }

  return {
    generated: now.toISOString(),
    snapshotAt: snap?.generated ?? '',
    snapshot: snapshotAge(snap?.generated ?? '', now),
    summary: {
      all: mine.length,
      action: mine.filter((p) => p.needs.length).length,
      drafts: mine.filter((p) => p.draft).length,
      approved: mine.filter((p) => p.review === 'APPROVED').length,
      failing: mine.filter((p) => p.tone === 'bad').length,
      reviews: reviews.length,
    },
    missedRoutines: missedRuns(cfg, now).map((run) => run.name),
    groups,
    reviews,
    runs: listRuns(cfg, { open: true }).map((r) => ({
      name: r.name,
      status: r.data.status,
      step: r.data.current_step,
      pr: String(r.data.pr ?? ''),
    })),
    tickets,
    sessions,
    standupTime: cfg.standup?.time ?? null,
    timezone: cfg.assistant.timezone,
    isWorkingDay: isWorkingDay(cfg, now),
  };
}

const DAY = 86400_000;

export function isWorkingDay(cfg: Config, d: Date): boolean {
  return (
    cfg.assistant.working_days.includes(localWeekday(cfg, d)) &&
    !(cfg.standup?.days_off ?? []).includes(localDay(cfg, d))
  );
}

/** Start of the previous working day in the owner's timezone (skips weekends, working_days and days off). */
export function previousWorkingDay(cfg: Config, now = new Date()): string {
  const off = new Set(cfg.standup?.days_off ?? []);
  const working = new Set(cfg.assistant.working_days);
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now.getTime() - i * DAY);
    const day = localDay(cfg, d);
    if (working.has(localWeekday(cfg, d)) && !off.has(day)) return day;
  }
  return localDay(cfg, new Date(now.getTime() - DAY));
}

export interface StandupFacts {
  since: string;
  groups: { key: string; facts: string[] }[];
}

/** The owner's own activity since the previous working day, grouped by ticket (or repo), as plain facts. */
export function standupFacts(cfg: Config, now = new Date()): StandupFacts {
  const since = previousWorkingDay(cfg, now);
  const self = cfg.people.self;
  const repos = new Set(cfg.repositories.map((r) => r.name));
  const workLink = (e: TimelineEvent) => e.links.some((l) => /^PR-/.test(l) || repos.has(l) || ticketsIn(l).length > 0);
  const authoredByMe = (prNote: string | undefined) =>
    !!prNote &&
    parseNote(readVaultFile(cfg.paths.vault, `${vaultFolder(cfg, 'prs')}/${prNote}.md`) ?? '').data.author ===
      `[[${self}]]`;
  const mine = (e: TimelineEvent) =>
    e.type === 'commits' ||
    (e.src === 'owner' && workLink(e)) ||
    (e.type === 'pr-opened' && e.title.endsWith(`by ${self}`)) ||
    (e.type === 'pr-merged' && authoredByMe(e.links.find((l) => l.startsWith('PR-')))) ||
    e.type === 'review-given' ||
    ((e.type === 'pr-comment' || e.type === 'ticket-comment' || e.type === 'worklog') && e.title.includes(` ${self}`));
  const evs = readEvents(cfg, { sinceDays: 16, now }).filter(
    (e) =>
      e.ts.slice(0, 10) >= since &&
      e.ts <= localStamp(cfg, now) &&
      e.type !== 'session' &&
      e.type !== 'feedback' &&
      mine(e),
  );
  const byKey = Map.groupBy(evs, (e) => ticketsIn(e.title, ...e.links)[0] ?? e.links[0] ?? 'Other');
  return {
    since,
    groups: [...byKey].map(([key, events]) => ({
      key,
      facts: events.map((e) => `${e.ts.slice(5, 16)} ${e.type}: ${e.title}`),
    })),
  };
}

/** The full drafting prompt: rules, the owner's voice card from the profile, and the facts. */
export function standupPrompt(cfg: Config, profileText: string, f: StandupFacts): string {
  const card = /## Voice card[\s\S]*?(?=\n## |$)/.exec(profileText)?.[0] ?? '';
  const facts =
    f.groups.map((g) => `${g.key}\n${g.facts.map((x) => `- ${x}`).join('\n')}`).join('\n\n') || '(nothing recorded)';
  return [
    'Write my standup update for the team call. Use only the facts below; never add work that is not there.',
    'Format: plain text, three short sections "Yesterday:", "Today:", "Blockers:". One line per item, grouped by ticket key. Simple everyday English in outcome words (what changed for users or the team), never PR titles, file names or tool names. Merge commits on the same ticket into one line. For Today, continue open items from the facts; if unclear write "Continue <ticket>". Blockers: "None" unless the facts show one.',
    'No em or en dashes, no emojis, no greeting, no sign-off.',
    card,
    `Facts since ${f.since}:`,
    facts,
  ].join('\n\n');
}
