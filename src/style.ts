import { styleText } from 'node:util';

/** How urgent something is. bad: broken, warn: needs you, good: done or approved, idle: nothing to do. */
export type Tone = 'bad' | 'warn' | 'good' | 'idle';

export const TONE_MARK: Record<Tone, string> = { bad: '✗', warn: '●', good: '✓', idle: '○' };
const TONE_FORMAT = { bad: 'red', warn: 'yellow', good: 'green', idle: 'dim' } as const;

type Format = Parameters<typeof styleText>[0];

/** Colour only for a person at a terminal: never into a pipe, a file or the vault. NO_COLOR and FORCE_COLOR are honoured. */
const colorEnabled = () =>
  process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY && !process.env.NO_COLOR;

export const paint = (format: Format, text: string): string =>
  colorEnabled() ? styleText(format, text, { validateStream: false }) : text;

export const paintTone = (tone: Tone, text: string): string => paint(TONE_FORMAT[tone], text);

/** The tone's mark, coloured: a red cross, a yellow dot, a green tick or a dim ring. */
export const mark = (tone: Tone): string => paintTone(tone, TONE_MARK[tone]);
