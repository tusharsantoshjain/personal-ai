import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { listRuns } from './runs.ts';
import { missedRoutines } from './schedule.ts';
import { localStamp, localWeekday } from './timeline.ts';

/** Short context printed at session start. Pure reads, no network. */
export function sessionBrief(cfg: Config, now = new Date()): string {
  const lines: string[] = [];
  lines.push(
    `${cfg.assistant.name} session start: ${localWeekday(cfg, now)} ${localStamp(cfg, now)} (${cfg.assistant.timezone})`,
  );
  const a = cfg.assistant.autonomy;
  lines.push(
    `Autonomy: ${a}.${a === 'autonomous' ? ` Runs without asking: ${cfg.approvals.autonomous_allow.join(', ')}.` : ' Risky actions ask the owner in chat.'}`,
  );
  lines.push(...missedRoutines(cfg, now));
  const nowFile = join(cfg.paths.vault, vaultFolder(cfg, 'dashboard'), 'Now.md');
  if (existsSync(nowFile)) {
    const hours = Math.round((now.getTime() - statSync(nowFile).mtimeMs) / 3600_000);
    lines.push(
      `Now.md: updated ${hours}h ago${hours > cfg.session_start.now_max_age_hours ? ' (stale, run `pai now` after a sync)' : ''}.`,
    );
  } else lines.push('Now.md: missing (run `pai now`).');
  if (!existsSync(cfg.paths.vault)) lines.push(`Vault not found at ${cfg.paths.vault}.`);
  else {
    const runs = listRuns(cfg, { open: true });
    if (runs.length) {
      lines.push(`Open runs (${runs.length}), resume from current_step:`);
      for (const r of runs)
        lines.push(
          `- ${r.name}: ${r.data.status}, step ${r.data.current_step}${r.data.failed_steps?.length ? `, failed ${r.data.failed_steps.join(',')}` : ''}${r.data.pr ? `, PR ${r.data.pr}` : ''}`,
        );
    } else lines.push('Open runs: none.');
  }
  return lines.slice(0, cfg.session_start.max_lines).join('\n');
}
