import type { Config } from './config.ts';
import { trackerKeyPattern, vaultFolder } from './config.ts';
import { appendLineToNote, parseNote, readVaultFile, stubNote } from './vault.ts';

const SECTIONS = { Completed: 'note', Decisions: 'decision', 'New knowledge': 'knowledge' } as const;
const EMPTY = /^(none|nothing|no decisions|no new)\b/i;

/** Top-level bullets of one `## <section>` in a daily note body. */
function bullets(body: string, section: string): string[] {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (i === -1) return [];
  const out: string[] = [];
  // shortcut: nested sub-bullets are skipped; the top-level bullet must carry the fact.
  for (let j = i + 1; j < lines.length && !/^#{1,2} /.test(lines[j]!); j++) {
    const m = /^- (.+)$/.exec(lines[j]!);
    if (m && !EMPTY.test(m[1]!.trim())) out.push(m[1]!.trim());
  }
  return out;
}

const links = (text: string): string[] => [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]!.trim());

/** Add one line to a ticket note's Log, creating the note when missing. Returns false if the line was already there. */
export function appendTicketLog(cfg: Config, key: string, day: string, line: string): boolean {
  return appendLineToNote(cfg.paths.vault, `${vaultFolder(cfg, 'tracker')}/${key}.md`, 'Log', line, day, () =>
    stubNote(key, { type: 'ticket', key, status: 'TBD' }, day),
  );
}

export interface PromoteResult {
  tickets: number;
  repos: number;
}

/**
 * Copy the daily note's Completed, Decisions and New knowledge bullets to the notes they link:
 * ticket notes (Log, created when missing) and repo cards (Traps). Idempotent: an existing line is not added twice.
 */
export function promoteDaily(cfg: Config, rel: string, day: string): PromoteResult {
  const res: PromoteResult = { tickets: 0, repos: 0 };
  const text = readVaultFile(cfg.paths.vault, rel);
  if (!text) return res;
  const { body } = parseNote(text);
  const key = trackerKeyPattern(cfg);
  for (const [section, kind] of Object.entries(SECTIONS)) {
    for (const b of bullets(body, section)) {
      for (const l of new Set(links(b))) {
        if (kind !== 'knowledge' && key.test(l)) {
          if (appendTicketLog(cfg, l, day, `- ${day} ${kind}: ${b}`)) res.tickets++;
        } else if (kind === 'knowledge') {
          const card = `${vaultFolder(cfg, 'repositories')}/${l}.md`;
          if (
            readVaultFile(cfg.paths.vault, card) !== undefined &&
            appendLineToNote(cfg.paths.vault, card, 'Traps', `- ${day}: ${b}`, day, () => stubNote(l, {}, day))
          )
            res.repos++;
        }
      }
    }
  }
  return res;
}
