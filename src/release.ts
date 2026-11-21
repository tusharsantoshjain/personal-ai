import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import type { GhClient } from './gh.ts';
import { runGit } from './git.ts';
import { startRun } from './runs.ts';
import {
  dedash,
  parseNote,
  readNotesIn,
  readVaultFile,
  renderNote,
  safeFileName,
  unwikilink,
  upsertNote,
  writeVaultFile,
} from './vault.ts';

export interface MergedPr {
  name: string;
  number: number;
  title: string;
  author: string;
  merged: string;
  base: string;
  tickets: string[];
}
export interface ReleaseNotes {
  repo: string;
  base: string;
  since: string;
  byTicket: { ticket: string; prs: MergedPr[]; fixVersions: string[] }[];
  noTicket: MergedPr[];
  fixVersionIssues: string[];
}

/** PRs merged into `base` of `repo` on or after `since` (YYYY-MM-DD), from the vault's PR notes. */
export function mergedPrs(cfg: Config, repo: string, base: string, since: string): MergedPr[] {
  return readNotesIn(cfg.paths.vault, vaultFolder(cfg, 'prs'))
    .filter(
      ({ name, data }) =>
        name.startsWith(`PR-${repo}-`) &&
        data.status === 'merged' &&
        data.base === base &&
        String(data.merged ?? '') >= since,
    )
    .map(({ name, data }) => ({
      name,
      number: Number(data.number),
      title: String(data.title ?? ''),
      author: unwikilink(data.author),
      merged: String(data.merged ?? ''),
      base,
      tickets: ((data.tickets as string[] | undefined) ?? []).map(unwikilink),
    }))
    .sort((a, b) => a.merged.localeCompare(b.merged));
}

export function releaseNotes(
  cfg: Config,
  repo: string,
  base: string,
  since: string,
  targetVersion?: string,
): ReleaseNotes {
  const prs = mergedPrs(cfg, repo, base, since);
  const byTicket = new Map<string, MergedPr[]>();
  const noTicket: MergedPr[] = [];
  for (const p of prs) {
    if (!p.tickets.length) {
      noTicket.push(p);
      continue;
    }
    for (const t of p.tickets) byTicket.set(t, [...(byTicket.get(t) ?? []), p]);
  }
  const fixVersionIssues: string[] = [];
  const groups = [...byTicket.entries()].map(([ticket, list]) => {
    const note = readVaultFile(cfg.paths.vault, `${vaultFolder(cfg, 'tracker')}/${ticket}.md`);
    const fixVersions = note ? ((parseNote(note).data.fix_versions as string[] | undefined) ?? []) : [];
    if (!note) fixVersionIssues.push(`${ticket}: not synced to the vault; fix version unknown`);
    else if (!fixVersions.length) fixVersionIssues.push(`${ticket}: no fix version`);
    else if (targetVersion && !fixVersions.includes(targetVersion))
      fixVersionIssues.push(`${ticket}: fix version ${fixVersions.join(', ')}, release is ${targetVersion}`);
    return { ticket, prs: list, fixVersions };
  });
  return { repo, base, since, byTicket: groups, noTicket, fixVersionIssues };
}

export function renderReleaseNotes(n: ReleaseNotes, targetVersion?: string): string {
  const lines = [
    `Merged into \`${n.base}\` since ${n.since}${targetVersion ? ` for ${targetVersion}` : ''}: ${n.byTicket.reduce((a, g) => a + g.prs.length, 0) + n.noTicket.length} PRs.`,
    '',
  ];
  for (const g of n.byTicket) {
    lines.push(`### [[${g.ticket}]]${g.fixVersions.length ? ` (fix ${g.fixVersions.join(', ')})` : ''}`);
    for (const p of g.prs) lines.push(`- [[${p.name}]] ${p.title} (${p.author}, ${p.merged})`);
    lines.push('');
  }
  if (n.noTicket.length) {
    lines.push('### No ticket');
    for (const p of n.noTicket) lines.push(`- [[${p.name}]] ${p.title} (${p.author}, ${p.merged})`);
    lines.push('');
  }
  lines.push(
    '### Fix version checks',
    ...(n.fixVersionIssues.length ? n.fixVersionIssues.map((x) => `- ${x}`) : ['- all tickets carry a fix version']),
  );
  return dedash(lines.join('\n'));
}

export function writeReleaseNote(cfg: Config, n: ReleaseNotes, day: string, targetVersion?: string): string {
  const rel = `${vaultFolder(cfg, 'projects')}/Releases/${safeFileName(`${n.repo} ${targetVersion ?? day}`)}.md`;
  upsertNote(cfg.paths.vault, rel, {
    data: {
      type: 'release',
      repo: `[[${n.repo}]]`,
      base: n.base,
      since: n.since,
      version: targetVersion ?? '',
      created: day,
    },
    preserveKeys: ['created'],
    blockId: 'release',
    block: renderReleaseNotes(n, targetVersion),
    title: `${n.repo} release ${targetVersion ?? day}`,
  });
  return rel;
}

export interface BranchCheck {
  missingDownmerge: string[];
  wrongBase: string[];
}

/** Commits on the release branch that the integration branch lacks, and open PRs aimed at the wrong base. */
export function releaseCheck(
  cfg: Config,
  repoDir: string,
  release: string,
  base: string,
  openPrs: { number: number; title: string; baseRefName: string; headRefName: string }[],
): BranchCheck {
  // cherry marks commits whose patch is already in base with "-": only "+" lines need a downmerge
  const cherry = runGit(repoDir, ['cherry', `origin/${base}`, `origin/${release}`])
    .split('\n')
    .filter((l) => l.startsWith('+ '));
  const missingDownmerge = cherry.map((l) => {
    const sha = l.slice(2);
    return `${sha.slice(0, 8)} ${runGit(repoDir, ['log', '-1', '--format=%s', sha])}`;
  });
  const wrongBase = openPrs
    .filter((p) => /^(hotfix|fix)\//i.test(p.headRefName) && p.baseRefName === base && !/release/i.test(p.title))
    .map(
      (p) =>
        `#${p.number} ${p.title}: hotfix branch targets ${base}; retarget to ${release} if it ships in this release`,
    )
    .concat(
      openPrs
        .filter((p) => p.baseRefName === release && /^(feature|feat|upgrade|noissue)\//i.test(p.headRefName))
        .map((p) => `#${p.number} ${p.title}: feature branch targets ${release}; retarget to ${base} unless agreed`),
    );
  return { missingDownmerge, wrongBase };
}

export function openPrsFor(gh: GhClient, login: string, repoFull: string) {
  return (
    gh.json<{ number: number; title: string; baseRefName: string; headRefName: string }[]>(login, [
      'pr',
      'list',
      '-R',
      repoFull,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,baseRefName,headRefName',
    ]) ?? []
  );
}

/** A run note holding a markdown checklist (e.g. a pre-deployment list), so a deploy is tracked step by step. */
export function checklistRun(cfg: Config, file: string, name: string): string {
  const raw = readFileSync(file, 'utf8');
  const body = dedash(raw.replace(/\u{1F195}\s*/gu, '(new) ')).replace(/^# .*\n/, '');
  const run = startRun(cfg, 'release', name);
  const rel = `${cfg.vault.runs_folder}/${run}.md`;
  const note = parseNote(readVaultFile(cfg.paths.vault, rel) ?? '');
  if (!note.body.includes('## Checklist')) {
    note.body = `${note.body.trimEnd()}\n\n## Checklist\nSource: \`${file}\` (values are never read or copied; check each in the AWS console or with the owner).\n${body}`;
    writeVaultFile(cfg.paths.vault, rel, renderNote(note));
  }
  return run;
}

export const repoDirOf = (cfg: Config, repo: string) => {
  const r = cfg.repositories.find((x) => x.name === repo);
  return r ? join(cfg.paths.workspace, r.path) : undefined;
};
