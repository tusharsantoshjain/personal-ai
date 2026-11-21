import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Desk, Filter, Tab, Tone } from '../types'
import {
  bandMinutes,
  filtered,
  hhmm,
  nextStep,
  resumeCommand,
  statusLine,
  TONE_COLOR,
  TONE_MARK,
  worstTone,
} from './logic'

const PANE = 'desk'
// The CLI is found through PAI_BIN, else `pai` on the PATH (npm link), else the default checkout location.
const PAI = [
  'sh',
  '-c',
  'exec "${PAI_BIN:-$(command -v pai || echo "$HOME/Developer/personal-ai/bin/pai")}" "$@"',
  'pai',
]

const tab = atom({ plugin: 'desk', key: 'tab' } as const, 'work' as Tab)
const filter = atom({ plugin: 'desk', key: 'filter' } as const, 'all' as Filter)
const data = atom({ plugin: 'desk', key: 'data' } as const, null as Desk | null)
const busy = atom({ plugin: 'desk', key: 'busy' } as const, '')
const error = atom({ plugin: 'desk', key: 'error' } as const, '')
const draft = atom({ plugin: 'desk', key: 'draft' } as const, '')
const history = atom({ plugin: 'desk', key: 'history' } as const, [] as string[])
const lint = atom({ plugin: 'desk', key: 'lint' } as const, '')
const bandHidden = atom({ plugin: 'desk', key: 'bandHidden' } as const, '')

function pai($: EngineInterface, args: string[], stdin?: string, timeoutMs = 30_000) {
  return $.process.run([...PAI, ...args], { stdin, timeoutMs })
}

async function load($: EngineInterface) {
  const r = await pai($, ['desk'])
  if (r.exitCode !== 0) return update($, error, () => r.stderr.trim().split('\n')[0] || `pai desk exited ${r.exitCode}`)
  const desk = JSON.parse(r.stdout) as Desk
  // `pai desk` judges each PR and counts them; an older pai sends neither
  if (!desk.summary) return update($, error, () => 'pai is older than this pane: update the personal-ai checkout')
  await update($, data, () => desk)
  await update($, error, () => '')
  $.ui.status(statusLine(desk))
}

async function refresh($: EngineInterface) {
  await update($, busy, () => 'Refreshing PRs from GitHub...')
  const r = await pai($, ['prs'], undefined, 180_000)
  if (r.exitCode !== 0) await update($, error, () => `pai prs: ${r.stderr.trim().split('\n')[0] || r.exitCode}`)
  await load($)
  await update($, busy, () => '')
}

async function standup($: EngineInterface) {
  await update($, busy, () => 'Drafting standup...')
  const p = await pai($, ['standup', '--prompt'])
  if (p.exitCode !== 0) {
    await update($, error, () => 'pai standup failed')
    return update($, busy, () => '')
  }
  const res = await $.model.complete({ model: 'sonnet', prompt: p.stdout })
  if (!res.isAnswered) {
    await update($, error, () => 'Model did not answer; try again')
    return update($, busy, () => '')
  }
  const old = await read($, draft)
  if (old) await update($, history, h => [...h, old].slice(-10))
  await update($, draft, () => res.text.trim())
  const l = await pai($, ['lint', 'text', '--channel', 'chat', '-'], res.text)
  await update($, lint, () => l.stdout.trim().split('\n').pop() ?? '')
  await update($, busy, () => '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'desk',
      description: 'Open the work desk: PRs by ticket, review queue, runs, standup draft',
    })
    void load($)
    $.clock.every(10 * 60_000, () => load($)) // local state only, no network
    return next(e)
  })

  on('command.run', { command: 'desk' }, async $ => {
    await load($)
    await $.ui.open({ id: PANE, title: 'Desk' })
    return { text: 'Desk opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const [t, f, d, b, err] = [
      await read($, tab),
      await read($, filter),
      await read($, data),
      await read($, busy),
      await read($, error),
    ]
    const counts = d?.summary ?? null
    const TABS = [
      { name: 'work', label: 'Work', hotkey: '1', count: counts?.all },
      { name: 'queue', label: 'Queue', hotkey: '2', count: counts?.reviews },
      { name: 'standup', label: 'Standup', hotkey: '3', count: undefined },
    ] as const

    /** A coloured mark and words: the unit every status in the pane is built from. */
    const chip = (key: string, kind: Tone, text: string) => (
      <Box key={key} gap={1}>
        <Text color={TONE_COLOR[kind]}>{TONE_MARK[kind]}</Text>
        <Text color={kind === 'idle' ? undefined : TONE_COLOR[kind]} dimColor={kind === 'idle'}>
          {text}
        </Text>
      </Box>
    )
    /** A titled, bordered block; the border takes the colour of the most urgent thing inside. */
    const section = (key: string, title: string, kind: Tone, note: string, rows: RenderChildren) => (
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderColor={TONE_COLOR[kind]}
        borderDimColor={kind === 'idle'}
        paddingX={1}
        marginTop={1}
      >
        <Box gap={1}>
          <Text bold>{title}</Text>
          <Text dimColor>{note}</Text>
        </Box>
        {rows}
      </Box>
    )

    const age = d?.snapshot ?? null
    const header = (
      <Box flexDirection="column">
        <Box gap={1}>
          {TABS.map(x => (
            <Button
              key={`tab-${x.name}`}
              label={x.count === undefined ? x.label : `${x.label} ${x.count}`}
              hotkey={x.hotkey}
              variant={x.name === t ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => x.name)}
            />
          ))}
          <Button key="refresh" label="Refresh" hotkey="r" dimColor onPress={() => refresh($)} />
        </Box>
        {counts && age ? (
          <Box gap={2} flexWrap="wrap">
            {counts.failing ? chip('sum-failing', 'bad', `${counts.failing} broken`) : null}
            {chip('sum-action', counts.action ? 'warn' : 'idle', `${counts.action} need action`)}
            {counts.approved ? chip('sum-approved', 'good', `${counts.approved} approved`) : null}
            {counts.reviews ? chip('sum-reviews', 'warn', `${counts.reviews} to review`) : null}
            <Text color={age.stale ? 'warning' : undefined} dimColor={!age.stale}>
              {age.text}
            </Text>
          </Box>
        ) : null}
        {b ? <Text color="suggestion">{b}</Text> : null}
        {err ? (
          <Text color="error">
            {TONE_MARK.bad} {err}
          </Text>
        ) : null}
      </Box>
    )
    if (!d) {
      if (!b && !err) void load($)
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Loading...</Text>
        </Box>
      )
    }

    if (t === 'work') {
      const groups = filtered(d, f)
      const FILTERS = [
        { name: 'all', label: 'All' },
        { name: 'action', label: 'Needs action' },
        { name: 'drafts', label: 'Drafts' },
        { name: 'approved', label: 'Approved' },
      ] as const
      return (
        <Box flexDirection="column">
          {header}
          <Box gap={1} marginTop={1}>
            {FILTERS.map(x => (
              <Button
                key={`f-${x.name}`}
                label={`${x.label} ${counts![x.name]}`}
                variant={x.name === f ? 'primary' : 'secondary'}
                onPress={() => update($, filter, () => x.name)}
              />
            ))}
          </Box>
          {groups.length === 0 ? (
            <Box marginTop={1}>
              {chip('empty', 'good', f === 'action' ? 'Nothing needs you right now.' : 'No PRs here.')}
            </Box>
          ) : null}
          {groups.map(g =>
            section(
              `g-${g.ticket}`,
              g.ticket,
              worstTone(g.prs),
              `${g.prs.length} PR${g.prs.length > 1 ? 's' : ''}`,
              g.prs.map((pr, i) => (
                <Box key={`pr-${pr.id}`} flexDirection="column" marginTop={i ? 1 : 0}>
                  <Box gap={1}>
                    <Text color={TONE_COLOR[pr.tone]}>{TONE_MARK[pr.tone]}</Text>
                    <Link href={pr.url} label={`${pr.repo}#${pr.number}`} />
                    <Text wrap="truncate-end">{pr.title}</Text>
                  </Box>
                  <Box gap={2} paddingLeft={2} flexWrap="wrap">
                    {pr.badges.map(badge => (
                      <Box key={`b-${pr.id}-${badge.text}`}>
                        <Text
                          color={badge.tone === 'idle' ? undefined : TONE_COLOR[badge.tone]}
                          dimColor={badge.tone === 'idle'}
                        >
                          {badge.text}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color={pr.needs.length ? 'warning' : undefined} dimColor={!pr.needs.length}>
                      {'→'} {nextStep(pr)}
                    </Text>
                  </Box>
                  <Box gap={1} paddingLeft={2}>
                    <Button
                      key={`open-${pr.id}`}
                      label="Copy link"
                      dimColor
                      onPress={press => $.ui.copy({ text: pr.url, surface: press.surface })}
                    />
                    <Button
                      key={`tell-${pr.id}`}
                      label="Tell chat"
                      dimColor
                      onPress={() => $.prompt.fill({ text: `${pr.url}: ${nextStep(pr)}`, mode: 'replace' })}
                    />
                    {resumeCommand(d, g.ticket) ? (
                      <Button
                        key={`go-${pr.id}`}
                        label="Go to chat"
                        dimColor
                        onPress={press => $.ui.copy({ text: resumeCommand(d, g.ticket)!, surface: press.surface })}
                      />
                    ) : null}
                  </Box>
                </Box>
              )),
            ),
          )}
        </Box>
      )
    }

    if (t === 'queue') {
      const none = (key: string, text: string) => (
        <Box key={key}>
          <Text dimColor>{text}</Text>
        </Box>
      )
      const runTone = (status: string): Tone => (status === 'blocked' || status === 'failed' ? 'bad' : 'warn')
      return (
        <Box flexDirection="column">
          {header}
          {section(
            'q-reviews',
            'Review requests',
            d.reviews.length ? 'warn' : 'idle',
            String(d.reviews.length),
            d.reviews.length
              ? d.reviews.map(pr => (
                  <Box key={`rv-${pr.id}`} gap={1}>
                    <Text color="warning">{TONE_MARK.warn}</Text>
                    <Link href={pr.url} label={`${pr.repo}#${pr.number}`} />
                    <Text wrap="truncate-end">{pr.title}</Text>
                    <Button
                      key={`rvb-${pr.id}`}
                      label="Review"
                      onPress={() =>
                        $.prompt.fill({
                          text: `Review ${pr.url} against our guidelines (pending review only).`,
                          mode: 'replace',
                        })
                      }
                    />
                  </Box>
                ))
              : none('q-reviews-none', 'Nobody is waiting on your review.'),
          )}
          {section(
            'q-runs',
            'Open runs',
            d.runs.some(r => runTone(r.status) === 'bad') ? 'bad' : 'idle',
            String(d.runs.length),
            d.runs.length
              ? d.runs.map(r => (
                  <Box key={`run-${r.name}`} gap={1}>
                    <Text color={TONE_COLOR[runTone(r.status)]}>{TONE_MARK[runTone(r.status)]}</Text>
                    <Text wrap="truncate-end">{r.name}</Text>
                    <Text dimColor>
                      {r.status} at {r.step}
                    </Text>
                  </Box>
                ))
              : none('q-runs-none', 'No work in progress.'),
          )}
          {section(
            'q-tickets',
            'Tickets in flight',
            'idle',
            String(d.tickets.length),
            d.tickets.length
              ? d.tickets.map(k => (
                  <Box key={`tk-${k.key}`} gap={1}>
                    <Text bold>{k.key}</Text>
                    <Text color="suggestion">{k.status}</Text>
                    <Text wrap="truncate-end">{k.summary}</Text>
                  </Box>
                ))
              : none('q-tickets-none', 'No tickets assigned to you in the vault.'),
          )}
        </Box>
      )
    }

    const text = await read($, draft)
    const hist = await read($, history)
    const l = await read($, lint)
    return (
      <Box flexDirection="column">
        {header}
        <Box gap={1} marginTop={1}>
          <Button
            key="gen"
            label={text ? 'Regenerate' : 'Draft standup'}
            hotkey="d"
            variant="primary"
            onPress={() => standup($)}
          />
          {text ? (
            <Button key="copy" label="Copy" hotkey="c" onPress={press => $.ui.copy({ text, surface: press.surface })} />
          ) : null}
          {text ? (
            <Button key="edit" label="Edit in prompt" onPress={() => $.prompt.fill({ text, mode: 'replace' })} />
          ) : null}
          {hist.length ? (
            <Button
              key="undo"
              label="Undo"
              dimColor
              onPress={async () => {
                const prev = hist[hist.length - 1]!
                await update($, history, h => h.slice(0, -1))
                await update($, draft, () => prev)
              }}
            />
          ) : null}
        </Box>
        {section(
          'standup-draft',
          'Standup',
          'idle',
          text ? 'draft' : 'no draft yet',
          <Box>
            {text ? (
              <Text>{text}</Text>
            ) : (
              <Text dimColor>
                Facts come from `pai standup` (since the previous working day; weekends and days off skipped).
              </Text>
            )}
          </Box>,
        )}
        {l ? chip('lint', l === 'clean' ? 'good' : 'warn', `Writing check: ${l}`) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = await read($, data)
    if (!d || e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const left = bandMinutes(hhmm(now, d.timezone), d.standupTime, d.isWorkingDay)
    const today = new Date(now).toISOString().slice(0, 10)
    if (left === null || (await read($, bandHidden)) === today) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="warning">
          {TONE_MARK.warn} Standup in {left} min{' '}
        </Text>
        <Button
          key="band-open"
          label="Open standup"
          onPress={async () => {
            await update($, tab, () => 'standup')
            await $.ui.open({ id: PANE, title: 'Desk' })
          }}
        />
        <Button key="band-hide" label="Hide" onPress={() => update($, bandHidden, () => today)} />
      </Box>
    )
  })
}
