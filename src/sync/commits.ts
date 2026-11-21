import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Repo } from '../config.ts';
import { vaultFolder } from '../config.ts';
import { runGit } from '../git.ts';
import { isProtected } from '../gate/index.ts';
import { ticketsIn } from '../prs.ts';
import { scrub } from '../scrub.ts';
import { addEvents, localDay, localStamp, type TimelineEvent } from '../timeline.ts';
import { readNotesIn, upsertNote } from '../vault.ts';
import { emptyReport, type SyncReport } from './report.ts';

/**
 * The owner's commits from local clones, including work on branches that never had a ticket or PR.
 * Each commit is assigned to the branch it was made on (closest non-protected remote branch), linked to
 * that branch's PR when the vault has one, and marked merged when a protected branch contains it.
 */
export interface Commit {
  sha: string;
  date: string;
  subject: string;
  branch: string;
  merged: boolean;
}

export function selfEmails(cfg: Config): Set<string> {
  return new Set(
    Object.entries(cfg.people.aliases)
      .filter(([k, v]) => k.includes('@') && v === cfg.people.self)
      .map(([k]) => k.toLowerCase()),
  );
}

function nameRev(cwd: string, shas: string[], refs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!shas.length || !refs.length) return out;
  const args = ['name-rev', '--name-only', '--annotate-stdin', ...refs.map((r) => `--refs=${r}`)];
  const lines = runGit(cwd, args, { input: shas.join('\n') + '\n' }).split('\n');
  shas.forEach((s, i) => {
    const n = (lines[i] ?? '').trim();
    if (n && n !== s && !n.includes('undefined'))
      out.set(s, n.replace(/^(remotes\/)?origin\//, '').replace(/[~^].*$/, ''));
  });
  return out;
}

export function readCommits(cfg: Config, repoDir: string, emails: Set<string>): Commit[] {
  const raw = runGit(repoDir, [
    'log',
    '--remotes=origin',
    '--no-merges',
    `--since=${cfg.github.since}`,
    '--format=%H%x09%aI%x09%ae%x09%s',
  ]);
  const mine = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter((p) => emails.has((p[2] ?? '').toLowerCase()))
    .reverse(); // oldest first
  if (!mine.length) return [];
  const remotes = runGit(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'));
  const prot = remotes.filter((r) => isProtected(cfg, r.replace('refs/remotes/origin/', '')));
  const work = remotes.filter((r) => !prot.includes(r));
  const shas = mine.map((p) => p[0]!);
  const merged = new Set(
    prot.length ? runGit(repoDir, ['rev-list', `--since=${cfg.github.since}`, ...prot]).split('\n') : [],
  );
  // Squash-merge teams: a commit already on a protected branch was pushed or squashed there; others belong to their work branch.
  const onProt = nameRev(
    repoDir,
    shas.filter((s) => merged.has(s)),
    prot,
  );
  const onWork = nameRev(
    repoDir,
    shas.filter((s) => !merged.has(s)),
    work,
  );
  return mine.map(([sha, date, , subject]) => ({
    sha: sha!,
    date: date!,
    subject: subject ?? '',
    branch: (merged.has(sha!) ? onProt.get(sha!) : onWork.get(sha!)) ?? '(unknown)',
    merged: merged.has(sha!),
  }));
}

function prByBranch(cfg: Config, repo: string): Map<string, string> {
  const m = new Map<string, string>();
  const folder = vaultFolder(cfg, 'prs');
  for (const { name, data } of readNotesIn(cfg.paths.vault, folder))
    if (name.startsWith(`PR-${repo}-`) && typeof data.branch === 'string') m.set(data.branch, name);
  return m;
}

export function renderCommits(cfg: Config, repo: Repo, commits: Commit[], prs: Map<string, string>) {
  const branches = [...Map.groupBy(commits, (c) => c.branch)]
    .map(([b, cs]) => ({ b, cs: cs.sort((x, y) => x.date.localeCompare(y.date)) }))
    .sort((x, y) => x.cs[0]!.date.localeCompare(y.cs[0]!.date));
  const summary = [
    '| Branch | Commits | First | Last | On base | PR |',
    '| --- | --- | --- | --- | --- | --- |',
    ...branches.map(
      ({ b, cs }) =>
        `| \`${b}\` | ${cs.length} | ${localDay(cfg, cs[0]!.date)} | ${localDay(cfg, cs[cs.length - 1]!.date)} | ${cs.filter((c) => c.merged).length}/${cs.length} | ${prs.get(b) ? `[[${prs.get(b)}]]` : 'none'} |`,
    ),
  ];
  const detail = branches.flatMap(({ b, cs }) => [
    `### ${b}`,
    '',
    ...cs.map(
      (c) =>
        `- ${localDay(cfg, c.date)} \`${c.sha.slice(0, 8)}\`${c.merged ? '' : ' (branch only)'} ${scrub(cfg, c.subject)}`,
    ),
    '',
  ]);
  const block = [
    `${commits.length} commits by ${cfg.people.self} since ${cfg.github.since} on ${branches.length} branches.`,
    '',
    ...summary,
    '',
    '## Commits by branch',
    '',
    ...detail,
  ].join('\n');
  const events: TimelineEvent[] = [];
  for (const { b, cs } of branches) {
    for (const [d, dcs] of Map.groupBy(cs, (c) => localDay(cfg, c.date))) {
      const subjects = dcs
        .map((c) => scrub(cfg, c.subject).slice(0, 60))
        .slice(0, 3)
        .join('; ');
      const last = dcs[dcs.length - 1]!;
      events.push({
        ts: localStamp(cfg, last.date),
        type: 'commits',
        title: `${repo.name} ${b}: ${dcs.length} commit${dcs.length > 1 ? 's' : ''}: ${subjects}${dcs.length > 3 ? '; ...' : ''}`,
        links: [repo.name, ...(prs.get(b) ? [prs.get(b)!] : []), ...ticketsIn(b, ...dcs.map((c) => c.subject))].slice(
          0,
          6,
        ),
        src: 'git',
        id: `git-${repo.name}-${b}-${d}`,
      });
    }
  }
  return { rel: `${vaultFolder(cfg, 'sources')}/Git/${repo.name}.md`, block, events };
}

export function syncCommits(cfg: Config, opts: { fetch?: boolean } = {}): SyncReport {
  const rep = emptyReport('commits');
  const emails = selfEmails(cfg);
  if (!emails.size) {
    rep.errors.push('no owner emails in people.aliases; add the commit emails mapped to people.self');
    return rep;
  }
  for (const r of cfg.repositories) {
    const dir = join(cfg.paths.workspace, r.path);
    if (!existsSync(join(dir, '.git'))) {
      rep.skipped++;
      continue;
    }
    try {
      if (opts.fetch) runGit(dir, ['fetch', '-q', '--prune', 'origin']);
      const commits = readCommits(cfg, dir, emails);
      if (!commits.length) {
        rep.skipped++;
        continue;
      }
      const r2 = renderCommits(cfg, r, commits, prByBranch(cfg, r.name));
      if (
        upsertNote(cfg.paths.vault, r2.rel, {
          data: { type: 'source', source: 'git', repo: `[[${r.name}]]` },
          blockId: 'git',
          block: r2.block,
          title: `${r.name} commits`,
        })
      )
        rep.notes++;
      rep.events += addEvents(cfg, r2.events);
    } catch (e) {
      rep.errors.push(`${r.name}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return rep;
}
