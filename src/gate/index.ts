import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { parseShell, tokenize, type Segment } from '../shell.ts';
import { classifyFileWrite } from './files.ts';
import { classifyGh } from './gh.ts';
import { classifyGit, realGit } from './git.ts';
import { classifyMcp } from './mcp.ts';
import { isSecretFile } from './paths.ts';
import { classifyOther } from './shell.ts';
import type { ClassifyOptions, Hit, HookInput } from './types.ts';

export { approvalKey, decide, type Decision } from './decide.ts';
export { isProtected, realGit } from './git.ts';
export type { ClassifyOptions, GitContext, Hit, HookInput } from './types.ts';

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const DECLARATIONS = new Set(['export', 'local', 'readonly', 'declare']);

/** Replace $NAME and ${NAME} with values set earlier in the same command; unknown names stay as written. */
function expandVariables(word: string, variables: Map<string, string>): string {
  return word.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, braced: string | undefined, bare: string | undefined) => variables.get(braced ?? bare ?? '') ?? whole,
  );
}

/** Note `S=/some/path` (also after export or local), so a later `> $S/out.log` is judged by its real path. */
function rememberAssignments(seg: Segment, variables: Map<string, string>): void {
  if (seg.nested) return;
  const words = tokenize(seg.raw).argv;
  const assignments = DECLARATIONS.has(words[0] ?? '') ? words.slice(1) : words;
  for (const word of assignments) {
    const match = ASSIGNMENT.exec(word);
    if (!match) break;
    const [, name, value] = match;
    // a value computed at run time ($(...) or backticks) cannot be known here
    if (/\$\(|`/.test(value!)) variables.delete(name!);
    else variables.set(name!, expandVariables(value!, variables));
  }
}

export function classify(cfg: Config, input: HookInput, opts: ClassifyOptions = {}): Hit[] {
  const git = opts.git ?? realGit;
  const home = opts.home ?? homedir();
  const t = input.tool_name;
  if (t === 'Bash' || t === 'PowerShell') {
    let cwd = input.cwd ?? cfg.paths.workspace;
    const hits: Hit[] = [];
    const variables = new Map<string, string>();
    for (const parsed of parseShell(String(input.tool_input.command ?? ''))) {
      rememberAssignments(parsed, variables);
      const expand = (word: string) => expandVariables(word, variables);
      const seg: Segment = { ...parsed, argv: parsed.argv.map(expand), redirects: parsed.redirects.map(expand) };
      const [name, firstArg] = seg.argv;
      if (!name) continue;
      if ((name === 'cd' || name === 'pushd') && firstArg && !seg.nested)
        cwd = resolve(cwd, firstArg.replace(/^~(?=\/|$)/, home));
      else if (name === 'git') hits.push(...classifyGit(cfg, seg.argv, seg, cwd, git));
      else if (name === 'gh') hits.push(...classifyGh(cfg, seg.argv, seg, cwd));
      else hits.push(...classifyOther(cfg, seg.argv, seg, cwd, home));
    }
    return hits;
  }
  if (t === 'Write' || t === 'Edit' || t === 'MultiEdit' || t === 'NotebookEdit')
    return classifyFileWrite(cfg, input, home);
  if (t === 'Read') {
    const p = String(input.tool_input.file_path ?? '');
    return p && isSecretFile(p, home)
      ? [{ cat: 'secret_read', why: `${basename(p)} holds secrets; ask the owner for the value instead` }]
      : [];
  }
  if (t.startsWith('mcp__')) return classifyMcp(cfg, input);
  return [];
}
