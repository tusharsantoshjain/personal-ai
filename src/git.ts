import { execFileSync } from 'node:child_process';

export interface GitOptions {
  input?: string;
  timeoutMs?: number;
}

/** Run git in `cwd` and return its output without the trailing newline. Throws when git fails. */
export function runGit(cwd: string, args: string[], { input, timeoutMs = 120_000 }: GitOptions = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  }).trimEnd();
}

/** Like runGit, but undefined when git fails (not a repo, unknown ref, timeout). */
export function tryGit(cwd: string, args: string[], options?: GitOptions): string | undefined {
  try {
    return runGit(cwd, args, options);
  } catch {
    return undefined;
  }
}
