import type { Config } from './config.ts';
import { vaultFolder } from './config.ts';
import { findSecrets } from './secrets.ts';
import { listNotes, parseNote, readVaultFile } from './vault.ts';

export interface VaultFinding {
  path: string;
  rule: string;
  message: string;
}

const DATE_KEYS = ['created', 'updated', 'opened', 'merged', 'closed', 'resolved', 'date', 'due'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Vault conformance with the Conventions note. Excluded folders (memory, sources, templates) are skipped. */
export function lintVault(cfg: Config): VaultFinding[] {
  const out: VaultFinding[] = [];
  const titles = new Map<string, string[]>();
  const sources = vaultFolder(cfg, 'sources');
  for (const path of listNotes(cfg.paths.vault, cfg.vault.lint_exclude)) {
    const text = readVaultFile(cfg.paths.vault, path) ?? '';
    const { data, body } = parseNote(text);
    const add = (rule: string, message: string) => out.push({ path, rule, message });
    const title = path.split('/').pop()!.replace(/\.md$/, '');
    titles.set(title.toLowerCase(), [...(titles.get(title.toLowerCase()) ?? []), path]);
    if (!text.startsWith('---\n')) add('frontmatter', 'missing frontmatter');
    else if (typeof data.type !== 'string' || !data.type) add('type', 'frontmatter has no type');
    for (const k of DATE_KEYS) {
      const v = data[k];
      if (v === undefined || v === null || v === '') continue;
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      if (!ISO_DAY.test(s)) add('date', `${k} is "${s}", expected YYYY-MM-DD`);
    }
    for (const [k, v] of Object.entries(data)) {
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals)
        if (typeof x === 'string' && /\[\[[^\]]*$|^[^[]*\]\]/.test(x))
          add('wikilink', `${k} has a broken wikilink "${x}"`);
    }
    if (!path.startsWith(sources + '/') && cfg.writing.banned_chars.some((c) => text.includes(c)))
      add('dash', 'contains an em or en dash');
    if (findSecrets(text).length) add('secret', 'secret-shaped text');
    const starts = [...body.matchAll(/<!-- sync:([\w-]+):start -->/g)].map((m) => m[1]);
    const ends = [...body.matchAll(/<!-- sync:([\w-]+):end -->/g)].map((m) => m[1]);
    for (const s of starts) if (!ends.includes(s)) add('sync-block', `sync block ${s} has no end marker`);
    if (data.type === 'pr' && !/^PR-.+-\d+$/.test(title)) add('name', 'PR notes are named PR-<repo>-<number>');
    if (data.type === 'ticket' && !/^[A-Z][A-Z0-9]+-\d+$/.test(title)) add('name', 'ticket notes are named by key');
    if (data.type === 'meeting' && !/^\d{4}-\d{2}-\d{2} /.test(title))
      add('name', 'meeting notes are named "YYYY-MM-DD <title>"');
    if (data.type === 'decision' && !/^ADR-\d+ /.test(title)) add('name', 'decision notes are named "ADR-<n> <title>"');
  }
  for (const [, paths] of titles)
    if (paths.length > 1)
      for (const p of paths)
        out.push({
          path: p,
          rule: 'duplicate',
          message: `same note name as ${paths.filter((x) => x !== p).join(', ')}`,
        });
  return out;
}
