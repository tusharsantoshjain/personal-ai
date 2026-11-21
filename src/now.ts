import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { loadSnapshot } from './prs.ts';
import { listRuns } from './runs.ts';
import { localStamp, readEvents } from './timeline.ts';
import { readVaultFile, upsertNote, writeIfChanged } from './vault.ts';
import { formatLooseEnds, looseEnds } from './loose.ts';
import { myOpenTickets } from './desk.ts';
import { humanizeState } from './text.ts';

/** Rewrite the generated part of Now.md from local state only (PR snapshot, runs, tickets, timeline). Pinned stays. */
export function rebuildNow(cfg: Config): { changed: boolean; text: string } {
  const lines: string[] = [];
  const snap = loadSnapshot(cfg);
  lines.push(
    `Generated ${localStamp(cfg)}${snap ? `, PR data from ${localStamp(cfg, snap.generated)}` : ', no PR snapshot yet (run `pai prs`)'}.`,
    '',
  );

  lines.push('### Needs attention');
  const needs = snap?.prs.filter((p) => p.needs.length) ?? [];
  for (const p of needs) lines.push(`- [[PR-${p.repo}-${p.number}]] ${p.needs.join('; ')}`);
  const runs = listRuns(cfg, { open: true });
  for (const r of runs.filter((x) => x.data.failed_steps?.length || x.data.status === 'blocked'))
    lines.push(`- Run [[${r.name}]] ${r.data.status} at ${r.data.current_step}`);
  if (lines[lines.length - 1] === '### Needs attention') lines.push('- nothing');

  lines.push('', '### Open runs');
  lines.push(
    ...(runs.length
      ? runs.map((r) => `- [[${r.name}]] step ${r.data.current_step}${r.data.pr ? `, PR ${r.data.pr}` : ''}`)
      : ['- none']),
  );

  lines.push('', '### Tickets in flight');
  const tickets = myOpenTickets(cfg);
  lines.push(
    ...(tickets.length
      ? tickets.map((t) => `- [[${t.key}]] ${t.status}: ${t.summary.slice(0, 80)}`)
      : ['- none in the vault']),
  );

  lines.push('', '### Open PRs');
  const open = snap?.prs.filter((p) => p.role === 'author') ?? [];
  lines.push(
    ...(open.length
      ? open.map(
          (p) =>
            `- [[PR-${p.repo}-${p.number}]]${p.draft ? ' draft' : ''}, ci ${p.ci}, ${p.review ? humanizeState(p.review) : 'no review'}${p.unresolved ? `, ${p.unresolved} unresolved` : ''}`,
        )
      : ['- none']),
  );
  const reviews = snap?.prs.filter((p) => p.role === 'reviewer') ?? [];
  if (reviews.length) {
    lines.push('', '### Review requests');
    lines.push(...reviews.map((p) => `- ${p.repo}#${p.number} ${p.title.slice(0, 70)} ${p.url}`));
  }

  lines.push('', '### Loose ends');
  lines.push(...formatLooseEnds(looseEnds(cfg)));

  lines.push('', '### Commitments (last 14 days)');
  const commits = readEvents(cfg, { sinceDays: 14, type: 'commitment' });
  lines.push(
    ...(commits.length
      ? commits.map((e) => `- ${e.ts.slice(0, 10)} ${e.title} ${e.links.map((l) => `[[${l}]]`).join(' ')}`)
      : ['- none recorded']),
  );

  const rel = `${vaultFolder(cfg, 'dashboard')}/Now.md`;
  const block = lines.join('\n');
  if (!readVaultFile(cfg.paths.vault, rel)) {
    const seed = `---\ntype: dashboard\n---\n# Now\n\n## Pinned\n- (your facts here; never overwritten)\n\n## Generated\n<!-- sync:now:start -->\n<!-- sync:now:end -->\n`;
    writeIfChanged(cfg.paths.vault, rel, seed);
  }
  const changed = upsertNote(cfg.paths.vault, rel, { blockId: 'now', block });
  return { changed, text: block };
}
