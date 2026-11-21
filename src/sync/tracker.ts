import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { vaultFolder } from '../config.ts';
import { addEvents, localDay, localStamp, type TimelineEvent } from '../timeline.ts';
import { upsertNote, writeIfChanged } from '../vault.ts';
import { scrub } from '../scrub.ts';
import { emptyReport, type SyncReport } from './report.ts';

/**
 * The CLI cannot call the Jira connector. The tracker-scout agent (or the sync skill) saves connector
 * search results as JSON into <cache>/tracker/*.json; this sync renders them. Accepts the Rovo shape
 * {issues:{nodes:[...]}}, the REST shape {issues:[...]}, or a bare array.
 */
interface User {
  displayName?: string;
  accountId?: string;
}
interface Comment {
  id: string;
  author?: User;
  created: string;
  body: unknown;
}
interface Worklog {
  id: string;
  author?: User;
  started: string;
  timeSpent?: string;
  comment?: unknown;
}
export interface Issue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: User | null;
    reporter?: User | null;
    priority?: { name?: string } | null;
    issuetype?: { name?: string };
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    fixVersions?: { name: string }[];
    labels?: string[];
    parent?: { key: string } | null;
    description?: unknown;
    comment?: { comments?: Comment[] };
    worklog?: { worklogs?: Worklog[] };
    sprint?: unknown;
    customfield_10020?: { name?: string; state?: string }[] | null;
    issuelinks?: {
      type?: { outward?: string; inward?: string };
      outwardIssue?: { key: string };
      inwardIssue?: { key: string };
    }[];
  };
}

/** Atlassian Document Format to plain text, enough for comments and descriptions. */
export function adfToText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const n = v as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string; url?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'mention') return n.attrs?.text ?? '@user';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'inlineCard') return n.attrs?.url ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type ?? ''))
    return `${n.type === 'listItem' ? '- ' : ''}${inner}\n`;
  return inner;
}

export function readTrackerDumps(dir: string): Issue[] {
  if (!existsSync(dir)) return [];
  const out = new Map<string, Issue>();
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    const r = raw as { issues?: { nodes?: Issue[] } | Issue[] };
    const list: Issue[] = Array.isArray(raw)
      ? (raw as Issue[])
      : Array.isArray(r.issues)
        ? r.issues
        : (r.issues?.nodes ?? []);
    for (const i of list)
      if (i?.key && i.fields) {
        const prev = out.get(i.key);
        // keep the richest copy: later files win, but never lose comments or worklogs
        out.set(
          i.key,
          prev
            ? {
                key: i.key,
                fields: {
                  ...prev.fields,
                  ...i.fields,
                  comment: i.fields.comment ?? prev.fields.comment,
                  worklog: i.fields.worklog ?? prev.fields.worklog,
                },
              }
            : i,
        );
      }
  }
  return [...out.values()];
}

const name = (cfg: Config, u?: User | null) =>
  u?.displayName ? (cfg.people.aliases[u.displayName] ?? u.displayName) : '';

export function renderIssue(cfg: Config, i: Issue) {
  const f = i.fields;
  const day = (s?: string | null) => (s ? localDay(cfg, s) : undefined);
  const sourceRel = `${vaultFolder(cfg, 'sources')}/Jira/${i.key}.md`;
  const assignee = name(cfg, f.assignee);
  const sprint = Array.isArray(f.customfield_10020)
    ? f.customfield_10020
        .map((s) => s.name)
        .filter(Boolean)
        .pop()
    : undefined;
  const links = (f.issuelinks ?? [])
    .map((l) =>
      l.outwardIssue
        ? `${l.type?.outward ?? 'relates to'} [[${l.outwardIssue.key}]]`
        : l.inwardIssue
          ? `${l.type?.inward ?? 'relates to'} [[${l.inwardIssue.key}]]`
          : '',
    )
    .filter(Boolean);
  const data: Record<string, unknown> = {
    type: 'ticket',
    key: i.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? 'TBD',
    issuetype: f.issuetype?.name,
    assignee: assignee ? `[[${assignee}]]` : '',
    reporter: f.reporter ? `[[${name(cfg, f.reporter)}]]` : undefined,
    priority: f.priority?.name,
    fix_versions: (f.fixVersions ?? []).map((v) => v.name),
    labels: f.labels ?? [],
    sprint,
    parent: f.parent?.key ? `[[${f.parent.key}]]` : undefined,
    project: `[[${i.key.split('-')[0]}]]`,
    created: day(f.created),
    updated: day(f.updated),
    resolved: day(f.resolutiondate),
    url: `https://${cfg.tracker.site}/browse/${i.key}`,
    source: `[[${sourceRel.replace(/\.md$/, '')}]]`,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  const comments = f.comment?.comments ?? [];
  const worklogs = f.worklog?.worklogs ?? [];
  const block = [
    `${f.status?.name ?? 'TBD'} | ${f.issuetype?.name ?? ''} | assignee ${assignee || 'none'} | fix ${(f.fixVersions ?? []).map((v) => v.name).join(', ') || 'none'} | comments ${comments.length} | worklogs ${worklogs.length}`,
    links.length ? `Links: ${links.join('; ')}` : '',
    `Raw: [[${sourceRel.replace(/\.md$/, '')}|full text]]`,
  ]
    .filter(Boolean)
    .join('\n');
  const source = scrub(
    cfg,
    [
      '---',
      'type: source',
      'source: jira',
      `url: https://${cfg.tracker.site}/browse/${i.key}`,
      '---',
      `# ${i.key} ${f.summary ?? ''}`,
      '',
      '## Description',
      '',
      adfToText(f.description).trim() || '(empty)',
      '',
      ...(comments.length
        ? [
            '## Comments',
            '',
            ...comments.flatMap((c) => [
              `### ${c.author?.displayName ?? '?'} ${c.created}`,
              '',
              adfToText(c.body).trim(),
              '',
            ]),
          ]
        : []),
      ...(worklogs.length
        ? [
            '## Worklogs',
            '',
            ...worklogs.map(
              (w) =>
                `- ${w.started} ${w.author?.displayName ?? '?'} ${w.timeSpent ?? ''} ${adfToText(w.comment).replace(/\s+/g, ' ').trim()}`,
            ),
            '',
          ]
        : []),
    ].join('\n'),
  );
  const events: TimelineEvent[] = [];
  if (f.created)
    events.push({
      ts: localStamp(cfg, f.created),
      type: 'ticket-created',
      title: `${i.key} ${f.summary ?? ''}`,
      links: [i.key],
      src: 'jira',
      id: `${i.key}-created`,
    });
  if (f.resolutiondate)
    events.push({
      ts: localStamp(cfg, f.resolutiondate),
      type: 'ticket-resolved',
      title: `${i.key} ${f.status?.name ?? ''} ${f.summary ?? ''}`,
      links: [i.key],
      src: 'jira',
      id: `${i.key}-resolved`,
    });
  for (const c of comments) {
    const who = name(cfg, c.author);
    events.push({
      ts: localStamp(cfg, c.created),
      type: 'ticket-comment',
      title: `${i.key} ${who}: ${scrub(cfg, adfToText(c.body).replace(/\s+/g, ' ')).slice(0, 90)}`,
      links: [i.key, ...(who ? [who] : [])],
      src: 'jira',
      id: `${i.key}-c-${c.id}`,
    });
  }
  for (const w of worklogs) {
    const who = name(cfg, w.author);
    events.push({
      ts: localStamp(cfg, w.started),
      type: 'worklog',
      title: `${i.key} ${who} ${w.timeSpent ?? ''}`,
      links: [i.key, ...(who ? [who] : [])],
      src: 'jira',
      id: `${i.key}-w-${w.id}`,
    });
  }
  return { rel: `${vaultFolder(cfg, 'tracker')}/${i.key}.md`, data, block, source, sourceRel, events };
}

export function syncTracker(cfg: Config, dir = join(cfg.paths.cache_dir, 'tracker')): SyncReport {
  const rep = emptyReport('tracker');
  let issues: Issue[] = [];
  try {
    issues = readTrackerDumps(dir);
  } catch (e) {
    rep.errors.push(`tracker dumps unreadable: ${(e as Error).message}`);
  }
  if (!issues.length) rep.errors.push(`no tracker dumps in ${dir}; save connector search results there as JSON first`);
  for (const i of issues) {
    try {
      const r = renderIssue(cfg, i);
      if (writeIfChanged(cfg.paths.vault, r.sourceRel, r.source)) rep.notes++;
      if (
        upsertNote(cfg.paths.vault, r.rel, {
          data: r.data,
          blockId: 'tracker',
          block: r.block,
          title: `${i.key} ${i.fields.summary ?? ''}`,
        })
      )
        rep.notes++;
      rep.events += addEvents(cfg, r.events);
    } catch (e) {
      rep.errors.push(`${i.key}: ${(e as Error).message}`);
    }
  }
  return rep;
}
