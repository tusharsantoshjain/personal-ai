import { readFileSync } from 'node:fs';

/** File text, or undefined when it cannot be read. */
export const readTextFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
export const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Values of a flag: --x v, --x=v, -x v, -xv, and a short flag group ending in the flag (-am v). */
export function flagValues(argv: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const n of names) {
      if (a === n && i + 1 < argv.length) out.push(argv[i + 1]!);
      else if (n.startsWith('--') && a.startsWith(n + '=')) out.push(a.slice(n.length + 1));
      else if (!n.startsWith('--') && a.startsWith(n) && a.length > n.length && !a.startsWith('--'))
        out.push(a.slice(n.length));
      else if (!n.startsWith('--') && /^-[a-zA-Z]+$/.test(a) && a.endsWith(n.slice(1)) && i + 1 < argv.length)
        out.push(argv[i + 1]!);
    }
  }
  return out;
}
export const has = (argv: string[], ...flags: string[]) =>
  argv.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(f + '=')));
export const shortFlag = (argv: string[], ch: string) => argv.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));
