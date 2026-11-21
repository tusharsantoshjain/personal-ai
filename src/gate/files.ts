import { isAbsolute, normalize, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { findSecrets } from '../secrets.ts';
import { isInScratch, scratchRoot, writeTargetHits } from './paths.ts';
import type { Hit, HookInput } from './types.ts';

export function classifyFileWrite(cfg: Config, input: HookInput, home: string): Hit[] {
  const toolInput = input.tool_input;
  const filePath = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
  if (!filePath) return [];
  const abs = isAbsolute(filePath) ? normalize(filePath) : resolve(input.cwd ?? cfg.paths.workspace, filePath);
  const content = [
    toolInput.content,
    toolInput.new_string,
    ...(Array.isArray(toolInput.edits) ? toolInput.edits.map((e) => (e as Record<string, unknown>)?.new_string) : []),
    toolInput.new_source,
  ]
    .filter((x): x is string => typeof x === 'string')
    .join('\n');
  const hits = writeTargetHits(cfg, abs, home);
  const vault = cfg.paths.vault;
  if (abs.startsWith(vault + '/')) {
    const sec = findSecrets(content);
    if (sec.length) hits.push({ cat: 'text_secret', why: `vault write contains secret-shaped text (${sec[0]!.kind})` });
    const rel = abs.slice(vault.length + 1);
    if (!rel.startsWith(cfg.vault.folders.sources + '/') && cfg.writing.banned_chars.some((c) => content.includes(c)))
      hits.push({ cat: 'text_dash', why: 'vault notes use no em or en dashes (95-Sources excepted)' });
  }
  if (abs.startsWith(cfg.paths.workspace + '/') && !isInScratch(cfg, abs) && /\.(log|out)$/.test(abs))
    hits.push({ cat: 'scratch_location', why: `log file belongs in ${scratchRoot(cfg)}/<TICKET>/` });
  return hits;
}
