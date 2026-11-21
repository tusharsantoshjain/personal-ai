import type { Desk, Filter, Pr, Tone } from '../types'

/** PRs a filter keeps. */
export function keep(pr: Pr, filter: Filter): boolean {
  if (filter === 'action') return pr.needs.length > 0
  if (filter === 'drafts') return pr.draft
  if (filter === 'approved') return pr.review === 'APPROVED'
  return true
}

/** Ticket groups after the filter, empty groups dropped. */
export function filtered(desk: Desk, filter: Filter): Desk['groups'] {
  return desk.groups
    .map(g => ({ ticket: g.ticket, prs: g.prs.filter(p => keep(p, filter)) }))
    .filter(g => g.prs.length > 0)
}

/** Theme colours, so the pane follows the person's theme. */
export const TONE_COLOR: Record<Tone, string> = { bad: 'error', warn: 'warning', good: 'success', idle: 'inactive' }
export const TONE_MARK: Record<Tone, string> = { bad: '\u2717', warn: '\u25cf', good: '\u2713', idle: '\u25cb' }
const TONE_RANK: Record<Tone, number> = { bad: 3, warn: 2, good: 1, idle: 0 }

/** The most urgent tone in a group, for its border. */
export function worstTone(prs: Pr[]): Tone {
  return prs.reduce((worst, pr) => (TONE_RANK[pr.tone] > TONE_RANK[worst] ? pr.tone : worst), 'idle' as Tone)
}

/** The one-line summary kept in the status line, or undefined when there is nothing to say. */
export function statusLine(desk: Desk): string | undefined {
  const { summary, missedRoutines } = desk
  const parts = [
    summary.failing ? `${TONE_MARK.bad} ${summary.failing} broken` : '',
    summary.action ? `${TONE_MARK.warn} ${summary.action} need action` : '',
    summary.reviews ? `${summary.reviews} to review` : '',
    summary.approved ? `${TONE_MARK.good} ${summary.approved} approved` : '',
    missedRoutines.length ? `${TONE_MARK.bad} ${missedRoutines.join(', ')} missed` : '',
  ].filter(Boolean)
  return parts.length ? `Desk: ${parts.join(' \u00b7 ')}` : undefined
}

/** Plain-words next step; falls back to a calm default. */
export function nextStep(pr: Pr): string {
  return pr.needs[0] ?? (pr.draft ? 'Draft: mark ready when done' : 'Nothing to do')
}

/** Minutes until the standup if inside the 15-minute window, else null. now and time are "HH:MM". */
export function bandMinutes(now: string, time: string | null, isWorkingDay: boolean): number | null {
  if (!time || !isWorkingDay) return null
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  const left = toMin(time) - toMin(now)
  return left >= 0 && left <= 15 ? left : null
}

/** "HH:MM" in a timezone. */
export function hhmm(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(ms),
  )
}

/** Resume command for the chat that last worked on a ticket. */
export function resumeCommand(desk: Desk, ticket: string): string | null {
  const id = desk.sessions[ticket]
  return id ? `claude --resume ${id}` : null
}
