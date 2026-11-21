import { join } from 'node:path';
import type { Config } from '../config.ts';
import { vaultFolder } from '../config.ts';
import { readJson, writeFileAtomic } from '../files.ts';
import { type GhClient, reviewThreads, type SearchPr, searchPrs, type Thread } from '../gh.ts';
import { ticketsIn } from '../prs.ts';
import { addEvents, localDay, localStamp, type TimelineEvent } from '../timeline.ts';
import { upsertNote, writeIfChanged } from '../vault.ts';
import { scrub } from '../scrub.ts';
import { emptyReport, type SyncReport } from './report.ts';
import { humanizeState } from '../text.ts';

interface Actor {
  login: string;
}
interface PrFull {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  body: string;
  author: Actor | null;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedBy: Actor | null;
  labels: { name: string }[];
  reviews: { id: string; author: Actor | null; state: string; body: string; submittedAt: string }[];
  comments: { id: string; author: Actor | null; body: string; createdAt: string; url: string }[];
}

const VIEW_FIELDS =
  'number,title,url,state,isDraft,body,author,createdAt,mergedAt,closedAt,updatedAt,baseRefName,headRefName,additions,deletions,changedFiles,mergedBy,labels,reviews,comments';

/** Name from a login that follows an org convention, e.g. AcmeJaneDoe or ACME-Bob-Roe. */
export function nameFromLogin(cfg: Config, login: string): string | undefined {
  for (const pre of cfg.people.login_prefixes ?? []) {
    if (!login.startsWith(pre) || login.length <= pre.length) continue;
    const rest = login.slice(pre.length).replace(/^[-_]/, '').replace(/\d+$/, '');
    const words = rest.split(/[-_]|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
    if (words.length >= 2) return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  }
  return undefined;
}
export const person = (cfg: Config, login: string | undefined | null) =>
  login ? (cfg.people.aliases[login] ?? nameFromLogin(cfg, login) ?? login) : 'unknown';
export const isBot = (cfg: Config, login: string | undefined | null) =>
  !login || cfg.people.bots.includes(login) || /\[bot\]$/.test(login) || login.startsWith('app/');

const cachePath = (cfg: Config) => join(cfg.paths.cache_dir, 'github-sync.json');

export const prNoteName = (repo: string, n: number) => `PR-${repo}-${n}`;

function rawSource(cfg: Config, pr: PrFull, repo: string, threads: Thread[]): string {
  const who = (a: Actor | null) => a?.login ?? 'ghost';
  const out = [
    `---`,
    `type: source`,
    `source: github`,
    `url: ${pr.url}`,
    `---`,
    `# ${repo}#${pr.number} ${pr.title}`,
    '',
    '## Description',
    '',
    pr.body?.trim() || '(empty)',
    '',
  ];
  if (pr.comments.length) {
    out.push('## Conversation', '');
    for (const c of pr.comments) out.push(`### ${who(c.author)} ${c.createdAt}`, '', c.body.trim(), '');
  }
  if (pr.reviews.length) {
    out.push('## Reviews', '');
    for (const r of pr.reviews)
      out.push(`### ${who(r.author)} ${r.state} ${r.submittedAt}`, '', r.body?.trim() || '(no summary)', '');
  }
  if (threads.length) {
    out.push('## Inline threads', '');
    for (const t of threads) {
      out.push(
        `### ${t.path}${t.line ? `:${t.line}` : ''} ${t.isResolved ? 'resolved' : 'unresolved'}${t.isOutdated ? ', outdated' : ''}`,
        '',
      );
      for (const c of t.comments.nodes)
        out.push(`- ${c.author?.login ?? 'ghost'} ${c.createdAt}: ${c.body.trim().replace(/\n+/g, ' ')}`);
      out.push('');
    }
  }
  return scrub(cfg, out.join('\n'));
}

function status(pr: PrFull) {
  return pr.mergedAt ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
}

export function renderPr(
  cfg: Config,
  pr: PrFull,
  repoFull: string,
  threads: Thread[],
): {
  rel: string;
  data: Record<string, unknown>;
  block: string;
  source: string;
  sourceRel: string;
  events: TimelineEvent[];
} {
  const repo = repoFull.split('/')[1]!;
  const name = prNoteName(repo, pr.number);
  const self = cfg.people.self;
  const author = person(cfg, pr.author?.login);
  const reviewers = [
    ...new Set(
      pr.reviews
        .filter((r) => !isBot(cfg, r.author?.login) && r.author?.login !== pr.author?.login)
        .map((r) => person(cfg, r.author?.login)),
    ),
  ];
  const tickets = ticketsIn(pr.title, pr.headRefName);
  const repoCfg = cfg.repositories.find((r) => r.name === repo);
  const sourceRel = `${vaultFolder(cfg, 'sources')}/GitHub/${repo}-${pr.number}.md`;
  const day = (s: string | null) => (s ? localDay(cfg, s) : undefined);
  const data: Record<string, unknown> = {
    type: 'pr',
    repo: `[[${repo}]]`,
    number: pr.number,
    title: pr.title,
    status: status(pr),
    author_login: pr.author?.login,
    ticket: tickets[0] ? `[[${tickets[0]}]]` : '',
    tickets: tickets.map((t) => `[[${t}]]`),
    project: repoCfg ? `[[${repoCfg.project}]]` : '',
    author: `[[${author}]]`,
    reviewers: reviewers.map((r) => `[[${r}]]`),
    base: pr.baseRefName,
    branch: pr.headRefName,
    opened: day(pr.createdAt),
    merged: day(pr.mergedAt),
    closed: pr.mergedAt ? undefined : day(pr.closedAt),
    url: pr.url,
    source: `[[${sourceRel.replace(/\.md$/, '')}]]`,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  const unresolved = threads.filter((t) => !t.isResolved && !t.isOutdated).length;
  const reviewLines = pr.reviews
    .filter((r) => !isBot(cfg, r.author?.login))
    .map((r) => `- ${day(r.submittedAt)} ${person(cfg, r.author?.login)}: ${humanizeState(r.state)}`);
  const block = [
    `${status(pr)} | ${pr.headRefName} -> ${pr.baseRefName} | +${pr.additions} -${pr.deletions} in ${pr.changedFiles} files | threads ${threads.length} (${unresolved} unresolved) | comments ${pr.comments.length}`,
    reviewLines.length ? `Reviews:\n${[...new Set(reviewLines)].join('\n')}` : 'Reviews: none',
    `Raw: [[${sourceRel.replace(/\.md$/, '')}|full text]]`,
  ].join('\n');

  const events: TimelineEvent[] = [];
  const links = [name, ...tickets];
  const tag = `${repo}#${pr.number}`;
  events.push({
    ts: localStamp(cfg, pr.createdAt),
    type: 'pr-opened',
    title: `${tag} ${pr.title} by ${author}`,
    links,
    src: 'github',
    id: `pr-${repo}-${pr.number}-opened`,
  });
  if (pr.mergedAt)
    events.push({
      ts: localStamp(cfg, pr.mergedAt),
      type: 'pr-merged',
      title: `${tag} ${pr.title}`,
      links,
      src: 'github',
      id: `pr-${repo}-${pr.number}-merged`,
    });
  else if (pr.closedAt && pr.state === 'CLOSED')
    events.push({
      ts: localStamp(cfg, pr.closedAt),
      type: 'pr-closed',
      title: `${tag} ${pr.title}`,
      links,
      src: 'github',
      id: `pr-${repo}-${pr.number}-closed`,
    });
  const mine = author === self;
  for (const r of pr.reviews) {
    const who = person(cfg, r.author?.login);
    if (isBot(cfg, r.author?.login) || r.author?.login === pr.author?.login) continue;
    if (who === self)
      events.push({
        ts: localStamp(cfg, r.submittedAt),
        type: 'review-given',
        title: `${tag} ${humanizeState(r.state)} for ${author}`,
        links: [...links, author],
        src: 'github',
        id: `pr-${repo}-${pr.number}-review-${r.id}`,
      });
    else if (mine)
      events.push({
        ts: localStamp(cfg, r.submittedAt),
        type: 'review-received',
        title: `${tag} ${humanizeState(r.state)} by ${who}`,
        links: [...links, who],
        src: 'github',
        id: `pr-${repo}-${pr.number}-review-${r.id}`,
      });
  }
  const comments = [
    ...pr.comments.map((c) => ({ id: c.id, login: c.author?.login, at: c.createdAt, body: c.body })),
    ...threads
      .map((t) => t.comments.nodes[0])
      .filter(Boolean)
      .map((c) => ({ id: c!.id, login: c!.author?.login, at: c!.createdAt, body: c!.body })),
  ];
  for (const c of comments) {
    if (isBot(cfg, c.login)) continue;
    const who = person(cfg, c.login);
    if (who === self && mine) continue; // own replies on own PR are noise
    if (who !== self && !mine) continue; // others talking on others' PRs
    const snippet = scrub(cfg, c.body.replace(/\s+/g, ' ')).slice(0, 90);
    events.push({
      ts: localStamp(cfg, c.at),
      type: 'pr-comment',
      title: `${tag} ${who}: ${snippet}`,
      links: [...links, who],
      src: 'github',
      id: `pr-${repo}-${pr.number}-c-${c.id}`,
    });
  }
  return {
    rel: `${vaultFolder(cfg, 'prs')}/${name}.md`,
    data,
    block,
    source: rawSource(cfg, pr, `${repoFull}`, threads),
    sourceRel,
    events,
  };
}

/** Sync PRs the owner authored or reviewed since github.since. Skips PRs unchanged since the last run. */
export function syncGithub(
  cfg: Config,
  gh: GhClient,
  opts: { full?: boolean; log?: (s: string) => void } = {},
): SyncReport {
  const rep = emptyReport('github');
  const cache = opts.full ? {} : readJson<Record<string, string>>(cachePath(cfg), {}); // PR url -> updatedAt last synced
  for (const acc of cfg.github.accounts) {
    const found = new Map<string, SearchPr>();
    for (const org of acc.orgs)
      for (const flag of ['--author', '--reviewed-by', '--commenter']) {
        try {
          for (const pr of searchPrs(gh, acc.login, org, flag, ['--created', `>=${cfg.github.since}`], 1000))
            found.set(pr.url, pr);
        } catch (e) {
          rep.errors.push((e as Error).message);
        }
      }
    opts.log?.(`${acc.login}: ${found.size} PRs`);
    for (const s of found.values()) {
      const repoFull = s.repository.nameWithOwner;
      if (cache[s.url] === s.updatedAt) {
        rep.skipped++;
        continue;
      }
      try {
        const pr = gh.json<PrFull>(acc.login, ['pr', 'view', String(s.number), '-R', repoFull, '--json', VIEW_FIELDS]);
        const threads = reviewThreads(gh, acc.login, repoFull, s.number);
        const r = renderPr(cfg, pr, repoFull, threads);
        if (writeIfChanged(cfg.paths.vault, r.sourceRel, r.source)) rep.notes++;
        if (
          upsertNote(cfg.paths.vault, r.rel, {
            data: r.data,
            blockId: 'github',
            block: r.block,
            title: `${repoFull.split('/')[1]}#${pr.number} ${pr.title}`,
          })
        )
          rep.notes++;
        rep.events += addEvents(cfg, r.events);
        cache[s.url] = s.updatedAt;
      } catch (e) {
        rep.errors.push((e as Error).message);
      }
    }
  }
  writeFileAtomic(cachePath(cfg), JSON.stringify(cache));
  return rep;
}
