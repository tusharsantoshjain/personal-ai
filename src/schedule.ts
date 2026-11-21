import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { localDay, localStamp, localWeekday } from './timeline.ts';

/** When each routine runs. Weekdays use launchd numbers: 1 is Monday. Kept free of heavy imports: the session-start hook reads it. */
export const ROUTINES = {
  brief: { hour: 9, minute: 30, weekdays: [1, 2, 3, 4, 5], what: 'Morning brief into the daily note' },
  eod: { hour: 19, minute: 0, weekdays: [1, 2, 3, 4, 5], what: 'Syncs, Now, lint, end-of-day daily note draft' },
  weekly: { hour: 18, minute: 0, weekdays: [5], what: 'Vault lint, stale PRs, usage stats' },
} as const;
export type RoutineName = keyof typeof ROUTINES;

export const routineLabel = (name: RoutineName) => `com.personal-ai.${name}`;
export const launchAgentsDir = () => join(homedir(), 'Library', 'LaunchAgents');
export const routineLogPath = (cfg: Config, name: RoutineName) => join(cfg.paths.logs_dir, 'routines', `${name}.log`);

const DAY_MS = 86_400_000;
const LATE_RUN_GRACE_MS = 60 * 60_000; // launchd runs a missed job on wake, so give it an hour before warning
const WEEKDAY_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The latest local day (today once its start time has passed) on which the routine was due. */
export function lastDueDay(cfg: Config, name: RoutineName, now: Date): string {
  const { hour, minute, weekdays } = ROUTINES[name];
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const weekdayOf = (d: Date) => WEEKDAY_NUMBER[localWeekday(cfg, d)]!;
  for (let daysBack = 0; daysBack < 8; daysBack++) {
    const day = new Date(now.getTime() - daysBack * DAY_MS);
    const stamp = localStamp(cfg, day);
    if (daysBack === 0 && stamp.slice(11) < startTime) continue;
    if ((weekdays as readonly number[]).includes(weekdayOf(day))) return stamp.slice(0, 10);
  }
  throw new Error(`routine ${name} has no weekdays`);
}

/** True when the routine's start time has passed today and it has not run today. Used by launchd runs, which also fire at login. */
export function isDueNow(cfg: Config, name: RoutineName, now = new Date()): boolean {
  const today = localDay(cfg, now);
  return lastDueDay(cfg, name, now) === today && lastRunDay(cfg, name) !== today;
}

/** Day of the last "<stamp> routine <name>" line in the routine's log, or undefined when it never ran. */
export function lastRunDay(cfg: Config, name: RoutineName): string | undefined {
  let log: string;
  try {
    log = readFileSync(routineLogPath(cfg, name), 'utf8');
  } catch {
    return undefined;
  }
  return [...log.matchAll(new RegExp(`^(\\d{4}-\\d{2}-\\d{2}) \\d{2}:\\d{2} routine ${name}\\b`, 'gm'))]
    .map((m) => m[1]!)
    .at(-1);
}

export interface MissedRun {
  name: RoutineName;
  dueDay: string;
  ranDay: string | undefined;
}

/** Installed routines whose last run is older than the last day they were due. */
export function missedRuns(cfg: Config, now = new Date(), agentsDir = launchAgentsDir()): MissedRun[] {
  return (Object.keys(ROUTINES) as RoutineName[])
    .filter((name) => existsSync(join(agentsDir, `${routineLabel(name)}.plist`)))
    .map((name) => ({
      name,
      dueDay: lastDueDay(cfg, name, new Date(now.getTime() - LATE_RUN_GRACE_MS)),
      ranDay: lastRunDay(cfg, name),
    }))
    .filter((run) => !run.ranDay || run.ranDay < run.dueDay);
}

/** One warning line per missed run, for the session-start brief. */
export function missedRoutines(cfg: Config, now = new Date(), agentsDir = launchAgentsDir()): string[] {
  return missedRuns(cfg, now, agentsDir).map(
    (run) =>
      `Routine ${run.name} did not run on ${run.dueDay} (last run: ${run.ranDay ?? 'never'}). Check \`launchctl print gui/$(id -u)/${routineLabel(run.name)}\`.`,
  );
}
