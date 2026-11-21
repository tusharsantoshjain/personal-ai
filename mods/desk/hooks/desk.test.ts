import { expect, test } from 'claude-code/testing'

import type { Desk, Pr } from '../types'
import { bandMinutes, filtered, nextStep, resumeCommand, statusLine, worstTone } from './logic'

const pr = (n: number, over: Partial<Pr> = {}): Pr => ({
  id: `o/api#${n}`,
  repo: 'api',
  number: n,
  title: `T${n}`,
  url: `https://x/${n}`,
  role: 'author',
  draft: false,
  base: 'develop',
  ci: 'pass',
  conflicts: false,
  review: '',
  unresolved: 0,
  staleDays: 0,
  tickets: ['ACME-1'],
  needs: [],
  tone: 'idle',
  badges: [{ text: 'CI passing', tone: 'good' }],
  ...over,
})
const desk = (): Desk => ({
  generated: '',
  snapshotAt: '2026-10-19T08:00:00Z',
  snapshot: { text: 'PR data 30 min ago', stale: false },
  summary: { all: 3, action: 1, drafts: 1, approved: 1, failing: 1, reviews: 0 },
  missedRoutines: [],
  reviews: [],
  runs: [],
  tickets: [],
  standupTime: '10:30',
  timezone: 'UTC',
  isWorkingDay: true,
  sessions: { 'ACME-2': 'abc' },
  groups: [
    {
      ticket: 'ACME-2',
      prs: [
        pr(2, {
          tickets: ['ACME-2'],
          ci: 'fail',
          needs: ['Fix failing CI: build'],
          tone: 'bad',
          badges: [{ text: 'CI failing', tone: 'bad' }],
        }),
      ],
    },
    {
      ticket: 'ACME-1',
      prs: [
        pr(1, { draft: true, badges: [{ text: 'draft', tone: 'idle' }] }),
        pr(3, { review: 'APPROVED', tone: 'good' }),
      ],
    },
  ],
})

test('filters keep the right PRs and drop empty groups', async () => {
  expect(filtered(desk(), 'action').map(g => g.ticket)).toEqual(['ACME-2'])
  expect(filtered(desk(), 'drafts').flatMap(g => g.prs.map(p => p.number))).toEqual([1])
  expect(filtered(desk(), 'approved').flatMap(g => g.prs.map(p => p.number))).toEqual([3])
  expect(filtered(desk(), 'all').length).toBe(2)
})

test('group border takes the most urgent tone; the status line sums the desk up', async () => {
  expect(worstTone([pr(1), pr(2, { tone: 'good' }), pr(3, { tone: 'warn' })])).toBe('warn')
  expect(worstTone([])).toBe('idle')
  expect(statusLine(desk())).toBe('Desk: \u2717 1 broken \u00b7 \u25cf 1 need action \u00b7 \u2713 1 approved')
  expect(statusLine({ ...desk(), missedRoutines: ['eod'] })).toMatch(/eod missed$/)
  const quiet = { all: 0, action: 0, drafts: 0, approved: 0, failing: 0, reviews: 0 }
  expect(statusLine({ ...desk(), summary: quiet })).toBe(undefined)
})

test('next step and resume command read plainly', async () => {
  expect(nextStep(pr(6, { needs: ['Resolve the merge conflict with develop'] }))).toBe(
    'Resolve the merge conflict with develop',
  )
  expect(nextStep(pr(7, { draft: true }))).toBe('Draft: mark ready when done')
  expect(resumeCommand(desk(), 'ACME-2')).toBe('claude --resume abc')
  expect(resumeCommand(desk(), 'ACME-1')).toBe(null)
})

test('reminder band shows only in the 15 minutes before standup on working days', async () => {
  expect(bandMinutes('10:15', '10:30', true)).toBe(15)
  expect(bandMinutes('10:29', '10:30', true)).toBe(1)
  expect(bandMinutes('10:14', '10:30', true)).toBe(null)
  expect(bandMinutes('10:31', '10:30', true)).toBe(null)
  expect(bandMinutes('10:20', '10:30', false)).toBe(null)
  expect(bandMinutes('10:20', null, true)).toBe(null)
})

test('work tab draws PRs by ticket and the needs-action filter narrows it', async ($, on) => {
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}) as never)
  on('process.run', async (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('desk') ? JSON.stringify(desk()) : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'desk', surface, component: 'Pane', requestId: 'desk', props: {} as never })
    await ui.press({ key: 'tab-work' }) // settles the load the first draw started
    expect(await ui.find({ type: 'Text', text: /CI failing/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 need action/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^draft$/ })).toBeDefined()
    await ui.press({ key: 'f-action' })
    expect(await ui.find({ type: 'Text', text: /^draft$/ })).toBeUndefined()
    expect(await ui.find({ key: 'go-o/api#2' })).toBeDefined()
    await ui.press({ key: 'f-all' })
    expect(await ui.find({ type: 'Text', text: /PR data 30 min ago/ })).toBeDefined()
    await ui.unmount()
  }
})
