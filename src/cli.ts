import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from './config.ts';
import { RealGh } from './gh.ts';
import { resetAgents } from './hook.ts';
import { lintVault } from './lint.ts';
import { find, record, resolve, RECORD_KINDS, type RecordKind } from './notes.ts';
import { rebuildNow } from './now.ts';
import { formatDigest, runDigest } from './prs.ts';
import { listRuns, setRun, showRun, startRun, stepRun } from './runs.ts';
import { doctor, install } from './setup.ts';
import { formatStats, computeStats } from './stats.ts';
import { isSyncName, runSyncs, SYNC_NAMES } from './sync/index.ts';
import { formatSyncReport } from './sync/report.ts';
import { lintText, type Channel } from './text.ts';
import { addEvents, EVENT_TYPES, type EventType, localDay, localStamp, readEvents } from './timeline.ts';
import { stableId } from './sync/local.ts';
import { deskData, standupFacts, standupPrompt } from './desk.ts';
import { renderDash } from './dash.ts';
import { finishTicket } from './done.ts';
import { formatLooseEnds, looseEnds } from './loose.ts';
import {
  checklistRun,
  openPrsFor,
  releaseCheck,
  releaseNotes,
  renderReleaseNotes,
  repoDirOf,
  writeReleaseNote,
} from './release.ts';
import { installRoutines, realDeps, runRoutine, uninstallRoutines } from './routines.ts';
import { isDueNow, ROUTINES, type RoutineName } from './schedule.ts';
import { mark, paint, paintTone, type Tone } from './style.ts';

const USAGE = `pai: personal assistant CLI

  doctor                         check the wiring
  install                        links, memory junction, workspace settings
  sync all|${SYNC_NAMES.join('|')} [--full] [--fetch]
  record <kind> "<text>" --on <ticket|repo#n|note> [--on ...] [--with <person> ...]
                                 kinds: ${RECORD_KINDS.join(', ')}
  now                            rewrite the generated part of Now.md
  loose-ends                     unpushed commits, uncommitted worktrees, recent drafts in .scratch
  done <ticket>                  remove a finished ticket's worktrees and scratch folder (keeps unsaved work)
  prs [--json]                   open PR and review-request digest
  find <query> | resolve <name>
  timeline add <type> "<title>" [--link X ...] [--src S] | timeline show [--days N] [--entity X] [--type T]
  run start <skill> <ticket> | run step <name> <step> done|failed|started [--note T] [--next S]
  run set <name> <key> <value> | run show [<name>]
  lint text [--channel C] [<text> | -]  |  lint vault
  stats [--days N]
  agents reset                   clear the running-agent counter
  routine brief|eod|weekly [--if-due]  run one routine now; --if-due runs only when today's run is due and missing
  release notes <repo> --since D [--base B] [--version V] [--write]
  release check <repo> --release <branch> [--base B]
  release checklist <file.md> --name <release>
  routines [install|uninstall]   list, install or remove the launchd schedule
  dash                           the whole desk on one screen, in colour (local state only)
  desk --json                    data for the desk pane (local state only)
  standup [--json|--prompt]      own activity since the previous working day, by ticket
`;

function out(s: string) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}
/**
 * Colour for report text that is also written to notes and logs, so it is added here and not in the formatter:
 * a line that is not a list item is a heading (bold); list items take the tone of the heading they sit under.
 */
function printReport(text: string, headingTones: Record<string, Tone> = {}): void {
  let tone: Tone | undefined;
  for (const line of text.split('\n')) {
    const isItem = /^\s*-\s/.test(line);
    if (!isItem) tone = Object.entries(headingTones).find(([heading]) => line.startsWith(heading))?.[1];
    out(isItem ? (tone ? `${mark(tone)}${line.replace(/^(\s*)-/, '$1')}` : line) : paint('bold', line));
  }
}

function fail(s: string, code = 1): never {
  process.stderr.write(s + '\n');
  process.exit(code);
}

type Command = (cfg: Config, rest: string[]) => void;

/** One entry per `pai <command>`. Add a command here and to USAGE. */
const COMMANDS: Record<string, Command> = {
  install(cfg, rest) {
    for (const l of install(cfg)) out(l);
  },
  sync(cfg, rest) {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { full: { type: 'boolean' }, fetch: { type: 'boolean' } },
      allowPositionals: true,
    });
    const what = positionals[0] ?? 'all';
    if (what !== 'all' && !isSyncName(what)) fail(`unknown sync: ${what}\n${USAGE}`);
    const reps = runSyncs(cfg, what === 'all' ? SYNC_NAMES : [what], {
      gh: new RealGh(),
      full: !!values.full,
      fetch: !!values.fetch,
      log: (line) => process.stderr.write(`  ${line}\n`),
    });
    for (const r of reps) {
      const [summaryLine, ...errors] = formatSyncReport(r);
      out(`${mark(errors.length ? 'bad' : 'good')} ${summaryLine}`);
      for (const error of errors) out(paintTone('bad', error));
    }
    if (reps.some((r) => r.errors.length && r.name !== 'tracker' && r.name !== 'memory')) process.exitCode = 2;
  },
  record(cfg, rest) {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { on: { type: 'string', multiple: true }, with: { type: 'string', multiple: true } },
      allowPositionals: true,
    });
    const [kind, text] = positionals;
    if (!kind || !text) fail(USAGE);
    if (!(RECORD_KINDS as readonly string[]).includes(kind))
      fail(`unknown kind ${kind}; use ${RECORD_KINDS.join(', ')}`);
    const r = record(cfg, kind as RecordKind, text, values.on ?? [], values.with ?? []);
    out(
      r.written.length || r.timelineAdded
        ? `recorded: ${r.written.join(', ') || 'timeline only'}${r.timelineAdded ? ' (+timeline)' : ''}`
        : 'already recorded; nothing changed',
    );
  },
  done(cfg, rest) {
    if (!rest[0]) fail('done <ticket>');
    for (const l of finishTicket(cfg, rest[0])) out(`${mark(l.startsWith('kept') ? 'warn' : 'good')} ${l}`);
  },
  'loose-ends'(cfg, rest) {
    for (const l of formatLooseEnds(looseEnds(cfg))) out(l);
  },
  now(cfg, rest) {
    const r = rebuildNow(cfg);
    out(r.text);
    out(r.changed ? 'Now.md updated' : 'Now.md unchanged');
  },
  prs(cfg, rest) {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
    const d = runDigest(cfg, new RealGh());
    if (values.json) out(JSON.stringify(d, null, 1));
    else printReport(formatDigest(d), { 'Needs action': 'warn', Open: 'idle', Changed: 'good', Errors: 'bad' });
    if (d.errors.length) process.exitCode = 2;
  },
  find(cfg, rest) {
    const q = rest.join(' ');
    for (const h of find(cfg, q)) out(`${h.path} (${h.score})${h.snippet ? `: ${h.snippet}` : ''}`);
  },
  resolve(cfg, rest) {
    const r = resolve(cfg, rest.join(' '));
    out(r ? `${r.name}${r.path ? ` -> ${r.path}` : ' (no note yet)'}` : 'not found');
    if (!r) process.exitCode = 1;
  },
  timeline(cfg, rest) {
    const [sub, ...args] = rest;
    if (sub === 'add') {
      const { values, positionals } = parseArgs({
        args,
        options: { link: { type: 'string', multiple: true }, src: { type: 'string' } },
        allowPositionals: true,
      });
      const [type, title] = positionals;
      if (!type || !title || !(EVENT_TYPES as readonly string[]).includes(type))
        fail(`timeline add <${EVENT_TYPES.join('|')}> "<title>"`);
      const ts = localStamp(cfg);
      const n = addEvents(cfg, [
        {
          ts,
          type: type as EventType,
          title,
          links: values.link ?? [],
          src: values.src ?? 'owner',
          id: `t-${stableId(type, title, ts.slice(0, 10))}`,
        },
      ]);
      out(n ? 'added' : 'already present');
      return;
    }
    const { values } = parseArgs({
      args,
      options: { days: { type: 'string' }, entity: { type: 'string' }, type: { type: 'string' } },
    });
    const evs = readEvents(cfg, {
      sinceDays: values.days ? Number(values.days) : 7,
      entity: values.entity,
      type: values.type,
    });
    for (const e of evs) out(`${e.ts} ${e.type} ${e.title}${e.links.length ? ` [${e.links.join(', ')}]` : ''}`);
    if (!evs.length) out('no events');
  },
  run(cfg, rest) {
    const [sub, ...a] = rest;
    if (sub === 'start') {
      if (!a[0]) fail('run start <skill> <ticket>');
      out(startRun(cfg, a[0], a[1] ?? ''));
      return;
    }
    if (sub === 'step') {
      const { values, positionals } = parseArgs({
        args: a,
        options: { note: { type: 'string' }, next: { type: 'string' } },
        allowPositionals: true,
      });
      const [name, step, outcome] = positionals;
      if (!name || !step || !['done', 'failed', 'started'].includes(outcome ?? ''))
        fail('run step <name> <step> done|failed|started');
      stepRun(cfg, name, step, outcome as 'done' | 'failed' | 'started', values.note ?? '', values.next);
      out('ok');
      return;
    }
    if (sub === 'set') {
      if (a.length < 3) fail('run set <name> <key> <value>');
      setRun(cfg, a[0]!, a[1]!, a.slice(2).join(' '));
      out('ok');
      return;
    }
    if (sub === 'show') {
      if (a[0]) return out(showRun(cfg, a[0]));
      const runs = listRuns(cfg, { open: true });
      for (const r of runs) out(`${r.name}: ${r.data.status} at ${r.data.current_step}`);
      if (!runs.length) out('no open runs');
      return;
    }
    return fail(USAGE);
  },
  lint(cfg, rest) {
    const [sub, ...a] = rest;
    if (sub === 'vault') {
      const f = lintVault(cfg);
      for (const x of f) out(`${x.path}: ${x.rule}: ${x.message}`);
      out(`${f.length} finding(s)`);
      process.exitCode = f.length ? 1 : 0;
      return;
    }
    if (sub === 'text') {
      const { values, positionals } = parseArgs({
        args: a,
        options: { channel: { type: 'string' } },
        allowPositionals: true,
      });
      const text = !positionals.length || positionals[0] === '-' ? readFileSync(0, 'utf8') : positionals.join(' ');
      const f = lintText(cfg, text, (values.channel ?? 'chat') as Channel);
      for (const x of f) out(`${x.severity}: ${x.rule}: ${x.message}`);
      out(
        f.length
          ? `${f.filter((x) => x.severity === 'error').length} error(s), ${f.filter((x) => x.severity === 'warn').length} warning(s)`
          : 'clean',
      );
      process.exitCode = f.some((x) => x.severity === 'error') ? 1 : 0;
      return;
    }
    return fail(USAGE);
  },
  stats(cfg, rest) {
    const { values } = parseArgs({ args: rest, options: { days: { type: 'string' } } });
    out(formatStats(computeStats(cfg, Number(values.days ?? 7))));
  },
  dash(cfg, rest) {
    for (const l of renderDash(cfg)) out(l);
  },
  desk(cfg, rest) {
    out(JSON.stringify(deskData(cfg)));
  },
  standup(cfg, rest) {
    const f = standupFacts(cfg);
    if (rest.includes('--json')) return out(JSON.stringify(f));
    if (rest.includes('--prompt')) {
      let prof = '';
      try {
        prof = readFileSync(cfg.paths.profile, 'utf8');
      } catch {
        prof = '';
      }
      return out(standupPrompt(cfg, prof, f));
    }
    out(`Since ${f.since}`);
    for (const g of f.groups) {
      out(g.key);
      for (const x of g.facts) out(`- ${x}`);
    }
    if (!f.groups.length) out('nothing recorded');
  },
  release(cfg, rest) {
    const [sub, ...a] = rest;
    const { values, positionals } = parseArgs({
      args: a,
      options: {
        base: { type: 'string' },
        since: { type: 'string' },
        version: { type: 'string' },
        release: { type: 'string' },
        name: { type: 'string' },
        write: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    if (sub === 'notes') {
      const repo = positionals[0];
      const r = cfg.repositories.find((x) => x.name === repo);
      if (!repo || !r || !values.since)
        fail('release notes <repo> --since YYYY-MM-DD [--base B] [--version V] [--write]');
      const n = releaseNotes(cfg, repo, values.base ?? r.default_branch, values.since, values.version);
      if (values.write) out(`written: ${writeReleaseNote(cfg, n, localDay(cfg), values.version)}`);
      out(renderReleaseNotes(n, values.version));
      return;
    }
    if (sub === 'check') {
      const repo = positionals[0];
      const r = cfg.repositories.find((x) => x.name === repo);
      const dir = repo ? repoDirOf(cfg, repo) : undefined;
      if (!repo || !r || !dir || !values.release) fail('release check <repo> --release <branch> [--base B]');
      const acc = cfg.github.accounts.find((x) => x.orgs.includes(r.org));
      const open = acc ? openPrsFor(new RealGh(), acc.login, `${r.org}/${r.name}`) : [];
      const c = releaseCheck(cfg, dir, values.release, values.base ?? r.default_branch, open);
      out(
        `Downmerge from ${values.release} into ${values.base ?? r.default_branch}: ${c.missingDownmerge.length ? '' : 'nothing missing'}`,
      );
      for (const x of c.missingDownmerge) out(`- [ ] ${x}`);
      out(`Retarget: ${c.wrongBase.length ? '' : 'no PR on the wrong base'}`);
      for (const x of c.wrongBase) out(`- [ ] ${x}`);
      return;
    }
    if (sub === 'checklist') {
      if (!positionals[0] || !values.name) fail('release checklist <file.md> --name <release-name>');
      out(`run: ${checklistRun(cfg, positionals[0], values.name)}`);
      return;
    }
    return fail('release notes|check|checklist');
  },
  routine(cfg, rest) {
    const n = rest[0] as RoutineName;
    if (!n || !(n in ROUTINES)) fail(`routine ${Object.keys(ROUTINES).join('|')}`);
    if (rest.includes('--if-due') && !isDueNow(cfg, n)) return; // silent: a logged line would count as today's run
    const r = runRoutine(cfg, n, realDeps());
    out(`${localStamp(cfg)} routine ${n}${r.skipped ? ` skipped: ${r.skipped}` : ''}`);
    for (const l of r.lines) out(`  ${l}`);
  },
  routines(cfg, rest) {
    if (rest[0] === 'install') {
      for (const l of installRoutines(cfg)) out(l);
      return;
    }
    if (rest[0] === 'uninstall') {
      for (const l of uninstallRoutines()) out(l);
      return;
    }
    for (const [n, r] of Object.entries(ROUTINES))
      out(
        `${n}: ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')} weekdays ${r.weekdays.join(',')}: ${r.what}`,
      );
  },
  agents(cfg, rest) {
    if (rest[0] === 'reset') {
      out(`cleared ${resetAgents(cfg)} counter file(s)`);
      return;
    }
    return fail(USAGE);
  },
};

const CHECK_TONE = { ok: 'good', warn: 'warn', fail: 'bad' } as const;
const CHECK_WORD = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;

function runDoctor(): void {
  const checks = doctor();
  for (const c of checks) {
    const tone = CHECK_TONE[c.status];
    out(
      `${mark(tone)} ${paintTone(tone, CHECK_WORD[c.status])} ${c.name}${c.detail ? paint('dim', `: ${c.detail}`) : ''}`,
    );
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  out(failed ? paintTone('bad', `${failed} check(s) failed`) : paintTone('good', 'doctor: clean'));
  process.exitCode = failed ? 1 : 0;
}

export function main(argv: string[]): void {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help') return out(USAGE);
  if (name === 'doctor') return runDoctor(); // must work with a broken config
  if (!Object.hasOwn(COMMANDS, name)) fail(`unknown command: ${name}\n${USAGE}`);
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    return fail((e as Error).message);
  }
  COMMANDS[name]!(cfg, rest);
}

// `pai ... | head` closes the pipe early; that is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

try {
  main(process.argv.slice(2));
} catch (e) {
  fail(`error: ${(e as Error).message}`);
}
