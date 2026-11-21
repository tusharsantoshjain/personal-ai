import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { isWorkingDay } from './desk.ts';
import { RealGh, type GhClient } from './gh.ts';
import { lintVault } from './lint.ts';
import { rebuildNow } from './now.ts';
import { loadSnapshot, runDigest } from './prs.ts';
import { computeStats, formatStats } from './stats.ts';
import { runSyncs, SYNC_NAMES } from './sync/index.ts';
import { formatSyncReport } from './sync/report.ts';
import { promoteDaily } from './promote.ts';
import { launchAgentsDir, routineLabel, routineLogPath, ROUTINES, type RoutineName } from './schedule.ts';
import { localDay, localStamp } from './timeline.ts';
import { readVaultFile, upsertNote, writeIfChanged } from './vault.ts';

export interface Exec {
  (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): { code: number; stdout: string; stderr: string };
}
export interface RoutineDeps {
  exec: Exec;
  gh: GhClient;
  now: Date;
  notify: (title: string, text: string) => void;
}

export const realExec: Exec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 15 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
};

export const realDeps = (): RoutineDeps => ({
  exec: realExec,
  gh: new RealGh(),
  now: new Date(),
  notify: (title, text) => {
    try {
      execFileSync('osascript', [
        '-e',
        `display notification ${JSON.stringify(text.slice(0, 200))} with title ${JSON.stringify(title)}`,
      ]);
    } catch {
      /* no GUI */
    }
  },
});

const DAILY_SEED = (day: string) =>
  `---\ntype: daily\ndate: "${day}"\n---\n# ${day}\n\n## What happened\n\n## Completed\n\n## Decisions\n\n## Blockers\n\n## Follow-ups\n\n## New knowledge\n\n## KPI evidence\n\n## Tomorrow\n`;

function dailyNote(cfg: Config, now: Date): { rel: string; day: string } {
  const day = localDay(cfg, now);
  const rel = `${vaultFolder(cfg, 'daily')}/${day}.md`;
  if (!readVaultFile(cfg.paths.vault, rel)) writeIfChanged(cfg.paths.vault, rel, DAILY_SEED(day));
  return { rel, day };
}

function claude(cfg: Config, d: RoutineDeps, prompt: string, extra: string[] = []): { ok: boolean; text: string } {
  const r = d.exec('claude', ['-p', prompt, '--output-format', 'text', ...extra], {
    cwd: cfg.paths.workspace,
    timeoutMs: 20 * 60_000,
  });
  return { ok: r.code === 0, text: (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim() };
}

/** Commit everything in the vault repo, and push when the vault has a remote. Returns what happened, for the log. */
function commitVault(cfg: Config, d: RoutineDeps, message: string): string {
  if (!existsSync(join(cfg.paths.vault, '.git'))) return 'skipped (not a git repo)';
  const git = (...args: string[]) => d.exec('git', ['-C', cfg.paths.vault, ...args]);
  const st = git('status', '--porcelain');
  if (st.code !== 0) return `failed: ${st.stderr.trim().slice(0, 200)}`;
  if (!st.stdout.trim()) return 'nothing to commit';
  const add = git('add', '-A');
  const c = add.code === 0 ? git('commit', '-q', '-m', message) : add;
  if (c.code !== 0) return `failed: ${(c.stderr || c.stdout).trim().slice(0, 200)}`;
  if (!git('remote').stdout.trim()) return 'committed';
  const push = git('push', '-q');
  return push.code === 0 ? 'committed and pushed' : `committed; push failed: ${push.stderr.trim().slice(0, 200)}`;
}

export interface RoutineResult {
  name: RoutineName;
  skipped?: string;
  lines: string[];
}

/** PR digest, Now.md and a model-written brief in the daily note. */
function runBrief(cfg: Config, d: RoutineDeps): string[] {
  const lines: string[] = [];
  const digest = runDigest(cfg, d.gh);
  rebuildNow(cfg);
  lines.push(
    `prs: ${digest.prs.length} open, ${digest.prs.filter((p) => p.needs.length).length} need action${digest.errors.length ? `, ${digest.errors.length} errors` : ''}`,
  );
  const reply = claude(cfg, d, 'What needs my attention?');
  const { rel } = dailyNote(cfg, d.now);
  upsertNote(cfg.paths.vault, rel, {
    blockId: 'brief',
    block: `## Morning brief (${localStamp(cfg, d.now).slice(11)})\n\n${reply.ok ? reply.text : `Brief failed: ${reply.text.slice(0, 300)}`}`,
  });
  lines.push(reply.ok ? `brief written to ${rel}` : `brief failed: ${reply.text.slice(0, 200)}`);
  d.notify(
    'Morning brief',
    reply.ok
      ? (reply.text
          .split('\n')
          .find((l) => l.trim().startsWith('-'))
          ?.replace(/^\s*-\s*/, '') ?? 'Ready in the daily note')
      : 'Brief failed; see logs',
  );
  return lines;
}

/** All syncs, Now.md, lint, a model-drafted daily note, promotion to ticket and repo notes, and a vault commit. */
function runEod(cfg: Config, d: RoutineDeps): string[] {
  const lines: string[] = [];
  const reports = runSyncs(cfg, SYNC_NAMES, { gh: d.gh, fetch: true });
  // "no tracker dumps" is expected on most days, so tracker errors stay out of the routine log
  for (const r of reports) lines.push(...formatSyncReport(r.name === 'tracker' ? { ...r, errors: [] } : r, 5));
  runDigest(cfg, d.gh);
  rebuildNow(cfg);
  const findings = lintVault(cfg);
  lines.push(`lint: ${findings.length} findings`);
  const { rel, day } = dailyNote(cfg, d.now);
  const reply = claude(
    cfg,
    d,
    `End of day for ${day}. Fill the daily note ${cfg.paths.vault}/${rel}: What happened, Completed, Decisions, Blockers, Follow-ups, New knowledge, KPI evidence, Tomorrow, from \`pai timeline show --days 1\`, \`pai standup\` and Now.md. Keep the "Morning brief" block. Use simple everyday English, links to notes, no em dashes. Do not commit, push, post or message anyone.`,
    ['--permission-mode', 'acceptEdits'],
  );
  lines.push(reply.ok ? 'daily note drafted' : `daily note failed: ${reply.text.slice(0, 200)}`);
  if (reply.ok) {
    const promoted = promoteDaily(cfg, rel, day);
    lines.push(`promote: ${promoted.tickets} ticket lines, ${promoted.repos} repo traps`);
  }
  const committed = commitVault(cfg, d, `EOD ${day}`);
  lines.push(`vault commit: ${committed}`);
  d.notify(
    'End of day',
    reply.ok ? `Daily note ready; vault ${committed}. Lint: ${findings.length}` : 'EOD draft failed; see logs',
  );
  return lines;
}

/** Vault lint, stale PRs and usage into the Weekly Check dashboard. */
function runWeekly(cfg: Config, d: RoutineDeps): string[] {
  const lines: string[] = [];
  const findings = lintVault(cfg);
  const snap = loadSnapshot(cfg);
  const stale = (snap?.prs ?? []).filter(
    (p) => p.role === 'author' && (p.staleDays >= cfg.github.stale_days || p.needs.length),
  );
  const stats = formatStats(computeStats(cfg, 7, d.now.getTime()));
  const block = [
    `Week ending ${localDay(cfg, d.now)}`,
    '',
    `### Vault lint: ${findings.length} finding(s)`,
    ...findings.slice(0, 20).map((f) => `- ${f.path}: ${f.rule}: ${f.message}`),
    '',
    `### Stale or blocked PRs: ${stale.length}`,
    ...stale.map((p) => `- [[PR-${p.repo}-${p.number}]] ${p.staleDays}d, ${p.needs.join('; ') || 'no activity'}`),
    '',
    '### Usage (7 days)',
    stats,
  ].join('\n');
  upsertNote(cfg.paths.vault, `${vaultFolder(cfg, 'dashboard')}/Weekly Check.md`, {
    data: { type: 'dashboard' },
    blockId: 'weekly',
    block,
    title: 'Weekly Check',
  });
  lines.push(`weekly: ${findings.length} lint findings, ${stale.length} stale PRs`);
  d.notify('Weekly check', `${findings.length} lint findings, ${stale.length} stale PRs`);
  return lines;
}

const ROUTINE_STEPS: Record<RoutineName, (cfg: Config, d: RoutineDeps) => string[]> = {
  brief: runBrief,
  eod: runEod,
  weekly: runWeekly,
};
const WORKING_DAY_ONLY: readonly RoutineName[] = ['brief', 'eod'];

export function runRoutine(cfg: Config, name: RoutineName, d: RoutineDeps): RoutineResult {
  if (WORKING_DAY_ONLY.includes(name) && !isWorkingDay(cfg, d.now))
    return { name, skipped: 'not a working day', lines: [] };
  return { name, lines: ROUTINE_STEPS[name](cfg, d) };
}

export function plist(cfg: Config, name: RoutineName, nodeBin: string): string {
  const r = ROUTINES[name];
  const intervals = r.weekdays
    .map(
      (w) =>
        `    <dict><key>Weekday</key><integer>${w}</integer><key>Hour</key><integer>${r.hour}</integer><key>Minute</key><integer>${r.minute}</integer></dict>`,
    )
    .join('\n');
  const log = routineLogPath(cfg, name);
  const path = [dirname(nodeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${routineLabel(name)}</string>
  <key>ProgramArguments</key>
  <array><string>${join(cfg.paths.assistant_repo, 'bin', 'pai')}</string><string>routine</string><string>${name}</string><string>--if-due</string></array>
  <key>WorkingDirectory</key><string>${cfg.paths.workspace}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function installRoutines(
  cfg: Config,
  exec: Exec = realExec,
  nodeBin = process.execPath,
  dir = launchAgentsDir(),
): string[] {
  const out: string[] = [];
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(cfg.paths.logs_dir, 'routines'), { recursive: true });
  const uid = String(process.getuid?.() ?? 501);
  for (const name of Object.keys(ROUTINES) as RoutineName[]) {
    const file = join(dir, `${routineLabel(name)}.plist`);
    exec('launchctl', ['bootout', `gui/${uid}`, file]);
    writeFileSync(file, plist(cfg, name, nodeBin));
    const r = exec('launchctl', ['bootstrap', `gui/${uid}`, file]);
    out.push(`${name}: ${r.code === 0 ? 'loaded' : `load failed: ${r.stderr.trim()}`} (${ROUTINES[name].what})`);
  }
  return out;
}

export function uninstallRoutines(exec: Exec = realExec, dir = launchAgentsDir()): string[] {
  const uid = String(process.getuid?.() ?? 501);
  return (Object.keys(ROUTINES) as RoutineName[]).map((name) => {
    const file = join(dir, `${routineLabel(name)}.plist`);
    if (!existsSync(file)) return `${name}: not installed`;
    exec('launchctl', ['bootout', `gui/${uid}`, file]);
    rmSync(file);
    return `${name}: removed`;
  });
}
