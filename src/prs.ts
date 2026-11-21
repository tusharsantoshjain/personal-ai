import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { readJson, writeFileAtomic } from './files.ts';
import { type GhClient, reviewThreads, type SearchPr, searchPrs } from './gh.ts';
import { humanizeState } from './text.ts';

export interface PrState {
  id: string; // owner/repo#n
  repo: string; // repo name
  number: number;
  title: string;
  url: string;
  role: 'author' | 'reviewer';
  draft: boolean;
  base: string;
  ci: 'pass' | 'fail' | 'pending' | 'none';
  failing: string[];
  conflicts: boolean;
  review: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  unresolved: number;
  updatedAt: string;
  staleDays: number;
  tickets: string[];
  needs: string[];
}

export interface Digest {
  generated: string;
  prs: PrState[];
  changes: string[];
  errors: string[];
}

interface PrView {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: string;
  baseRefName: string;
  headRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  updatedAt: string;
  statusCheckRollup: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[];
}

export const TICKET_RE = /\b(?!(?:UTF|ISO|SHA|HTTP|RFC|CVE|GHSA|WCAG|ES|TLS|SSL|X)-)[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
export const ticketsIn = (...texts: string[]) => [...new Set(texts.flatMap((t) => t.match(TICKET_RE) ?? []))];

function ciState(rollup: PrView['statusCheckRollup']): { ci: PrState['ci']; failing: string[] } {
  if (!rollup?.length) return { ci: 'none', failing: [] };
  const failing = rollup
    .filter((c) =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
        (c.conclusion ?? c.state ?? '').toUpperCase(),
      ),
    )
    .map((c) => c.name ?? c.context ?? '?');
  if (failing.length) return { ci: 'fail', failing };
  const pending = rollup.some(
    (c) =>
      (c.status && c.status !== 'COMPLETED') ||
      ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes((c.state ?? '').toUpperCase()),
  );
  return { ci: pending ? 'pending' : 'pass', failing: [] };
}

export function nextSteps(cfg: Config, p: Omit<PrState, 'needs'>): string[] {
  const n: string[] = [];
  if (p.role === 'reviewer') return [`Review requested on ${p.repo}#${p.number}`];
  if (p.ci === 'fail') n.push(`Fix failing CI: ${p.failing.slice(0, 3).join(', ')}`);
  if (p.conflicts) n.push(`Resolve the merge conflict with ${p.base}`);
  if (p.unresolved) n.push(`Address ${p.unresolved} unresolved review thread${p.unresolved > 1 ? 's' : ''}`);
  else if (p.review === 'CHANGES_REQUESTED') n.push('Changes requested; reply and push fixes');
  if (!n.length && !p.draft && p.review === 'APPROVED' && p.ci !== 'fail') n.push('Approved; owner can merge');
  if (!n.length && !p.draft && p.review !== 'APPROVED' && p.staleDays >= cfg.github.stale_days)
    n.push(`Waiting on review for ${p.staleDays}d; follow up`);
  return n;
}

export function buildDigest(cfg: Config, gh: GhClient, now = new Date()): Digest {
  const prs: PrState[] = [];
  const errors: string[] = [];
  for (const acc of cfg.github.accounts) {
    const sets: [PrState['role'], string][] = [
      ['author', '--author'],
      ['reviewer', '--review-requested'],
    ];
    for (const [role, flag] of sets) {
      let found: SearchPr[] = [];
      try {
        for (const org of acc.orgs) found.push(...searchPrs(gh, acc.login, org, flag, ['--state', 'open'], 100));
      } catch (e) {
        errors.push((e as Error).message);
        continue;
      }
      found = found.filter((f, i) => found.findIndex((g) => g.url === f.url) === i);
      for (const s of found) {
        const repo = s.repository.nameWithOwner;
        try {
          const v = gh.json<PrView>(acc.login, [
            'pr',
            'view',
            String(s.number),
            '-R',
            repo,
            '--json',
            'number,title,url,isDraft,state,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,updatedAt,statusCheckRollup',
          ]);
          const threads = role === 'author' ? reviewThreads(gh, acc.login, repo, s.number) : [];
          const { ci, failing } = ciState(v.statusCheckRollup);
          const base: Omit<PrState, 'needs'> = {
            id: `${repo}#${v.number}`,
            repo: s.repository.name,
            number: v.number,
            title: v.title,
            url: v.url,
            role,
            draft: v.isDraft,
            base: v.baseRefName,
            ci,
            failing,
            conflicts: v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY',
            review: v.reviewDecision ?? '',
            unresolved: threads.filter((t) => !t.isResolved && !t.isOutdated).length,
            updatedAt: v.updatedAt,
            staleDays: Math.floor((now.getTime() - Date.parse(v.updatedAt)) / 86400_000),
            tickets: ticketsIn(v.title, v.headRefName),
          };
          prs.push({ ...base, needs: nextSteps(cfg, base) });
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    }
  }
  return {
    generated: now.toISOString(),
    prs: prs.sort((a, b) => b.needs.length - a.needs.length || a.id.localeCompare(b.id)),
    changes: [],
    errors,
  };
}

/** What changed since the last snapshot. Only meaningful changes, no noise. */
export function diffDigest(prev: Digest | undefined, cur: Digest): string[] {
  if (!prev) return ['first digest; no previous snapshot'];
  const old = new Map(prev.prs.map((p) => [`${p.role}:${p.id}`, p]));
  const out: string[] = [];
  for (const p of cur.prs) {
    const o = old.get(`${p.role}:${p.id}`);
    const tag = `${p.repo}#${p.number}`;
    if (!o) {
      out.push(`${tag}: new ${p.role === 'reviewer' ? 'review request' : 'open PR'}`);
      continue;
    }
    if (o.ci !== p.ci) out.push(`${tag}: CI ${o.ci} -> ${p.ci}`);
    if (o.review !== p.review && p.review) out.push(`${tag}: review ${humanizeState(p.review)}`);
    if (p.unresolved > o.unresolved) out.push(`${tag}: ${p.unresolved - o.unresolved} new unresolved thread(s)`);
    if (o.conflicts !== p.conflicts) out.push(`${tag}: ${p.conflicts ? 'now has conflicts' : 'conflicts resolved'}`);
    if (o.draft && !p.draft) out.push(`${tag}: marked ready`);
    old.delete(`${p.role}:${p.id}`);
  }
  for (const o of old.values())
    out.push(
      `${o.repo}#${o.number}: no longer open (${o.role === 'reviewer' ? 'review done or request removed' : 'merged or closed'})`,
    );
  return out;
}

const snapPath = (cfg: Config) => join(cfg.paths.cache_dir, 'prs.json');
export const loadSnapshot = (cfg: Config) => readJson<Digest | undefined>(snapPath(cfg), undefined);
export const saveSnapshot = (cfg: Config, digest: Digest) =>
  writeFileAtomic(snapPath(cfg), JSON.stringify(digest, null, 1));

export function runDigest(cfg: Config, gh: GhClient): Digest {
  const prev = loadSnapshot(cfg);
  const cur = buildDigest(cfg, gh);
  cur.changes = diffDigest(prev, cur);
  if (!cur.errors.length || cur.prs.length || !existsSync(snapPath(cfg))) saveSnapshot(cfg, cur);
  return cur;
}

export function formatDigest(d: Digest): string {
  const lines: string[] = [];
  const act = d.prs.filter((p) => p.needs.length);
  const rest = d.prs.filter((p) => !p.needs.length);
  lines.push(act.length ? 'Needs action' : 'Needs action: nothing');
  for (const p of act)
    lines.push(
      `- ${p.repo}#${p.number}${p.draft ? ' (draft)' : ''} ${p.title.slice(0, 70)}: ${p.needs.join('; ')} ${p.url}`,
    );
  if (rest.length) {
    lines.push('Open, nothing to do');
    for (const p of rest)
      lines.push(
        `- ${p.repo}#${p.number}${p.draft ? ' (draft)' : ''} ci ${p.ci}, ${p.review ? humanizeState(p.review) : 'no review'}`,
      );
  }
  if (d.changes.length) {
    lines.push('Changed since last check');
    for (const c of d.changes) lines.push(`- ${c}`);
  }
  if (d.errors.length) {
    lines.push('Errors');
    for (const e of d.errors) lines.push(`- ${e}`);
  }
  return lines.join('\n');
}
