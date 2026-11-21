export type Tone = 'bad' | 'warn' | 'good' | 'idle'
export type Badge = { text: string; tone: Tone }

/** One PR as `pai desk` sends it, already judged: how urgent it is and its facts as short labels. */
export type Pr = {
  id: string
  repo: string
  number: number
  title: string
  url: string
  role: 'author' | 'reviewer'
  draft: boolean
  base: string
  ci: 'pass' | 'fail' | 'pending' | 'none'
  conflicts: boolean
  review: string
  unresolved: number
  staleDays: number
  tickets: string[]
  needs: string[]
  tone: Tone
  badges: Badge[]
}
export type Desk = {
  generated: string
  snapshotAt: string
  snapshot: { text: string; stale: boolean }
  summary: { all: number; action: number; drafts: number; approved: number; failing: number; reviews: number }
  missedRoutines: string[]
  groups: { ticket: string; prs: Pr[] }[]
  reviews: Pr[]
  runs: { name: string; status: string; step: string; pr: string }[]
  tickets: { key: string; status: string; summary: string }[]
  sessions: Record<string, string>
  standupTime: string | null
  timezone: string
  isWorkingDay: boolean
}
export type Tab = 'work' | 'queue' | 'standup'
export type Filter = 'all' | 'action' | 'drafts' | 'approved'

declare module 'claude-code' {
  interface PluginState {
    desk: {
      tab: Tab
      filter: Filter
      data: Desk | null
      busy: string
      error: string
      draft: string
      history: string[]
      lint: string
      bandHidden: string
    }
  }
}
