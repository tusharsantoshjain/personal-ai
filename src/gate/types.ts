import type { Category } from '../config.ts';

export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
  tool_response?: unknown;
}

export interface Hit {
  cat: Category;
  why: string;
}

export interface GitContext {
  branch(cwd: string): string | undefined;
  isMainCheckout(cwd: string): boolean;
}

export interface ClassifyOptions {
  git?: GitContext;
  home?: string;
}
