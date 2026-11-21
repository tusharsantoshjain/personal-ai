import type { Config } from './config.ts';
import { maskSecrets } from './secrets.ts';

/**
 * Remove personal data from external text before it reaches the vault: emails outside the team,
 * labelled names and logins, credential pairs, UUIDs and long numeric ids.
 * ponytail: label-based, so an unlabelled student name in free prose is not caught; add an NER pass
 * or a redact-terms list if that shows up in review.
 */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LABELLED =
  /\b([Ss]tudent|[Ll]earner|[Cc]hild|[Pp]upil|[Pp]arent|[Gg]uardian|[Tt]eacher|[Uu]ser ?[Nn]ame|[Uu]sername|[Ll]ogin|[Ff]irst ?[Nn]ame|[Ll]ast ?[Nn]ame|[Ff]ull ?[Nn]ame|[Uu]ser)(\s+(?:[Nn]ame|[Ii][Dd]|[Ll]ogin|[Ee]mail))?(\s*[:=]\s*)(?!\[)([^\s,;|)}\]]+(?: [A-Z][^\s,;|)}\]]*){0,2})/g;
const CRED_PAIR = /\b[\w.@-]{3,}\s+\/\s+(?=\S*\d)[^\s/]{6,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_ID = /(?<![\w.#/-])\d{8,}(?![\w.-])/g;

export function scrub(cfg: Config, text: string): string {
  if (!text) return text;
  const team = new Set(
    Object.keys(cfg.people.aliases)
      .filter((k) => k.includes('@'))
      .map((k) => k.toLowerCase()),
  );
  return maskSecrets(text)
    .replace(EMAIL, (m) => (team.has(m.toLowerCase()) || /noreply|github\.com$/.test(m) ? m : '[email]'))
    .replace(CRED_PAIR, '[credentials]')
    .replace(
      LABELLED,
      (_m, label: string, kind: string | undefined, sep: string) => `${label}${kind ?? ''}${sep}[redacted]`,
    )
    .replace(UUID, '[id]')
    .replace(LONG_ID, '[id]');
}
