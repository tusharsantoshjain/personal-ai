import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config, Level } from '../config.ts';
import { levelOf } from '../config.ts';
import type { Hit, HookInput } from './types.ts';

export type Decision =
  | { kind: 'pass' }
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'approval'; key: string; reason: string; scope?: SessionScope };

/** One Drive file the owner can approve for the rest of a session, so a run of edits to it asks once. */
export interface SessionScope {
  key: string;
  label: string;
}

const SCOPED_CATEGORY = 'drive_write';
/** Edits only: sharing, trashing and clearing a file always ask. */
const SCOPED_TOOL = /^(update|append|insert)_/;
const FILE_ID_FIELDS = ['spreadsheetId', 'documentId', 'fileId'];

/** The file a call edits, when the call is an edit to one Drive file and nothing else about it is gated. */
export function sessionScope(input: HookInput, gated: Hit[]): SessionScope | undefined {
  if (!input.session_id || !gated.every((h) => h.cat === SCOPED_CATEGORY)) return undefined;
  const nameParts = input.tool_name.split('__');
  const tool = nameParts.pop() ?? '';
  const fileId = FILE_ID_FIELDS.map((field) => input.tool_input[field]).find((v) => typeof v === 'string');
  if (!SCOPED_TOOL.test(tool.toLowerCase()) || typeof fileId !== 'string') return undefined;
  const key = createHash('sha256')
    .update([input.session_id, nameParts.join('__'), fileId].join('\n'))
    .digest('hex')
    .slice(0, 12);
  return { key, label: `file ${fileId.slice(0, 12)}` };
}

export const RANK: Record<Level, number> = { safe: 0, controlled: 1, never: 2 };

/**
 * Key for one exact action. The harness may drop or add a leading `cd <dir> &&` depending on the current
 * folder, so leading cds are folded into the effective folder; the description field is not part of the action.
 */
export function approvalKey(input: HookInput): string {
  const { description: _d, ...rest } = input.tool_input;
  let action: unknown = rest;
  if ((input.tool_name === 'Bash' || input.tool_name === 'PowerShell') && typeof rest.command === 'string') {
    let cmd = rest.command.trim();
    let cwd = input.cwd ?? '';
    for (
      let m = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(cmd);
      m;
      m = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(cmd)
    ) {
      cwd = resolve(cwd || '/', m[1]!.replace(/^["']|["']$/g, ''));
      cmd = cmd.slice(m[0].length);
    }
    action = { ...rest, command: cmd, cwd };
  }
  return createHash('sha256')
    .update(`${input.tool_name}\n${JSON.stringify(action)}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Turn hits into a decision. `granted` says whether the owner already approved this exact call;
 * `sessionGranted` whether they approved the file it edits for this session.
 */
export function decide(
  cfg: Config,
  input: HookInput,
  hits: Hit[],
  granted: (key: string) => boolean,
  sessionGranted: (scopeKey: string) => boolean = () => false,
): Decision {
  const gated = hits.filter((h) => levelOf(cfg, h.cat) !== 'safe');
  if (!gated.length) return { kind: 'pass' };
  const worst = gated.reduce((m, h) => Math.max(m, RANK[levelOf(cfg, h.cat)]), 0);
  const list = (hs: Hit[]) =>
    [...new Map(hs.map((h) => [`${h.cat}:${h.why}`, h])).values()].map((h) => `${h.cat}: ${h.why}`).join('; ');
  if (worst === RANK.never) {
    return {
      kind: 'deny',
      reason: `BLOCKED by policy (never). ${list(gated.filter((h) => levelOf(cfg, h.cat) === 'never'))}. Fix the cause or take another path; do not retry this call or route around it with another tool or wording.`,
    };
  }
  const autonomy = cfg.assistant.autonomy;
  if (autonomy === 'manual')
    return {
      kind: 'deny',
      reason: `Autonomy is manual (plan only). ${list(gated)}. Show the plan to the owner instead.`,
    };
  if (autonomy === 'autonomous' && gated.every((h) => cfg.approvals.autonomous_allow.includes(h.cat)))
    return { kind: 'allow', reason: `autonomous: ${list(gated)}. Report the link and exact text to the owner.` };
  const scope = sessionScope(input, gated);
  if (scope && sessionGranted(scope.key))
    return { kind: 'allow', reason: `approved by owner for this session (${scope.label})` };
  const key = approvalKey(input);
  if (granted(key)) return { kind: 'allow', reason: `approved by owner [approval:${key}]` };
  if (input.agent_id || !cfg.approvals.ask_in_chat)
    return { kind: 'ask', reason: `Needs owner approval: ${list(gated)}` };
  const options = scope
    ? `options "Approve", "Approve this file for the session" (later edits to this same file then run without asking) and "Deny"`
    : `options "Approve" and "Deny"`;
  return {
    kind: 'approval',
    key,
    scope,
    reason: `APPROVAL NEEDED [approval:${key}] ${list(gated)}. Ask the owner with AskUserQuestion: include "[approval:${key}]" and what will happen in the question, ${options}. On Approve, retry this exact call once, unchanged. On Deny or a typed note, do not retry; follow the note or take another path. Never route around this with another tool or wording.`,
  };
}
