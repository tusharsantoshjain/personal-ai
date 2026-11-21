import { readFileSync } from 'node:fs';
import { handle } from './hook.ts';

// Entry for bin/hook. Reads one hook event from stdin and prints the response (or nothing).
const out = handle(readFileSync(0, 'utf8'));
if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
