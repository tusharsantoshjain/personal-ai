import type { Config } from './config.ts';
import { deskData, type DeskPr } from './desk.ts';
import { looseEnds } from './loose.ts';
import { lastRunDay, ROUTINES, type RoutineName } from './schedule.ts';
import { mark, paint, paintTone, type Tone } from './style.ts';
import { localStamp, localWeekday, readEvents } from './timeline.ts';

const TITLE_WIDTH = 64;
const fit = (text: string, width = TITLE_WIDTH) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

const heading = (title: string, count?: number) => [
  '',
  paint('bold', title.toUpperCase()) + (count === undefined ? '' : paint('dim', ` ${count}`)),
];

const chip = (tone: Tone, text: string) => `${mark(tone)} ${paintTone(tone, text)}`;

/** A PR on two or three lines: mark, id and title; its facts; then what to do when it needs you. */
function prLines(pr: DeskPr): string[] {
  const facts = pr.badges.map((badge) => paintTone(badge.tone, badge.text)).join(paint('dim', ' · '));
  return [
    ` ${mark(pr.tone)} ${paint('bold', `${pr.repo}#${pr.number}`)}  ${fit(pr.title)}`,
    `     ${facts}`,
    ...(pr.needs.length ? [`     ${paintTone('warn', `→ ${pr.needs.join('; ')}`)}`] : []),
  ];
}

/**
 * The whole desk on one terminal screen: what needs you first, then everything else that is open.
 * Reads local state only (PR snapshot, vault, logs); `pai prs` refreshes the PR data.
 */
export function renderDash(cfg: Config, now = new Date()): string[] {
  const desk = deskData(cfg, now);
  const { summary } = desk;
  const prs = desk.groups.flatMap((group) => group.prs);
  const needsYou = prs.filter((pr) => pr.tone === 'bad' || pr.tone === 'warn');
  const waiting = prs.filter((pr) => !needsYou.includes(pr));

  const lines = [
    `${paint('bold', `${cfg.assistant.name} desk`)}  ${paint('dim', `${localWeekday(cfg, now)} ${localStamp(cfg, now)}`)}  ${paintTone(desk.snapshot.stale ? 'warn' : 'idle', desk.snapshot.text)}`,
    '',
    [
      ...(summary.failing ? [chip('bad', `${summary.failing} broken`)] : []),
      chip(summary.action ? 'warn' : 'idle', `${summary.action} need action`),
      ...(summary.approved ? [chip('good', `${summary.approved} approved`)] : []),
      ...(summary.reviews ? [chip('warn', `${summary.reviews} to review`)] : []),
      ...(desk.missedRoutines.length ? [chip('bad', `${desk.missedRoutines.join(', ')} missed`)] : []),
    ].join('   '),
  ];

  lines.push(...heading('Needs you', needsYou.length));
  lines.push(...(needsYou.length ? needsYou.flatMap(prLines) : [` ${chip('good', 'Nothing needs you right now.')}`]));

  if (desk.reviews.length) {
    lines.push(...heading('Review requests', desk.reviews.length));
    for (const pr of desk.reviews)
      lines.push(
        ` ${mark('warn')} ${paint('bold', `${pr.repo}#${pr.number}`)}  ${fit(pr.title)}`,
        `     ${paint('dim', pr.url)}`,
      );
  }
  if (waiting.length) {
    lines.push(...heading('Open, nothing to do', waiting.length));
    lines.push(...waiting.flatMap(prLines));
  }
  if (desk.tickets.length) {
    lines.push(...heading('Tickets in flight', desk.tickets.length));
    for (const ticket of desk.tickets)
      lines.push(` ${paint('bold', ticket.key)}  ${paint('cyan', ticket.status)}  ${fit(ticket.summary)}`);
  }
  if (desk.runs.length) {
    lines.push(...heading('Open runs', desk.runs.length));
    for (const run of desk.runs) {
      const stuck = run.status === 'blocked' || run.status === 'failed';
      lines.push(` ${mark(stuck ? 'bad' : 'warn')} ${run.name}  ${paint('dim', `${run.status} at ${run.step}`)}`);
    }
  }
  const ends = looseEnds(cfg, now.getTime());
  if (ends.length) {
    const label = { unpushed: 'not pushed', uncommitted: 'not committed', draft: 'draft' } as const;
    lines.push(...heading('Loose ends', ends.length));
    for (const end of ends)
      lines.push(` ${mark('warn')} ${end.where}  ${paint('dim', `${label[end.kind]}: ${end.detail}`)}`);
  }
  const commitments = readEvents(cfg, { sinceDays: 14, type: 'commitment', now });
  if (commitments.length) {
    lines.push(...heading('Commitments, last 14 days', commitments.length));
    for (const event of commitments) lines.push(` ${paint('dim', event.ts.slice(0, 10))}  ${fit(event.title, 90)}`);
  }

  lines.push(...heading('Routines'));
  for (const name of Object.keys(ROUTINES) as RoutineName[]) {
    const ranDay = lastRunDay(cfg, name);
    const tone: Tone = desk.missedRoutines.includes(name) ? 'bad' : ranDay ? 'good' : 'idle';
    lines.push(` ${mark(tone)} ${name.padEnd(7)} ${paint('dim', ranDay ? `last ran ${ranDay}` : 'has not run yet')}`);
  }
  return lines;
}
