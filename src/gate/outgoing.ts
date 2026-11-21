import type { Config } from '../config.ts';
import { findSecrets } from '../secrets.ts';
import { hardWrappedLines } from '../text.ts';
import type { Hit } from './types.ts';

/** Outgoing text checks shared by commits, PR text, comments and connector payloads. */
export function textHits(cfg: Config, text: string, where: string, prose: boolean): Hit[] {
  const hits: Hit[] = [];
  const lower = text.toLowerCase();
  if (cfg.writing.banned_chars.some((c) => text.includes(c)))
    hits.push({ cat: 'text_dash', why: `${where} contains an em or en dash; use a comma, colon or full stop` });
  const attr = cfg.writing.ai_attribution.find((a) => lower.includes(a.toLowerCase()));
  if (attr) hits.push({ cat: 'text_attribution', why: `${where} contains AI attribution "${attr}"` });
  const sec = findSecrets(text);
  if (sec.length) hits.push({ cat: 'text_secret', why: `${where} contains secret-shaped text (${sec[0]!.kind})` });
  if (prose) {
    const hw = hardWrappedLines(text);
    if (hw.length)
      hits.push({ cat: 'text_hardwrap', why: `${where} is hard-wrapped at line ${hw[0]}; use one line per paragraph` });
  }
  return hits;
}

/** Every string inside a JSON value. */
export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
