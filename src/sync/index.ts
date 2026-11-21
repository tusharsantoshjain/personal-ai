import type { Config } from '../config.ts';
import type { GhClient } from '../gh.ts';
import { syncCommits } from './commits.ts';
import { syncGithub } from './github.ts';
import { syncDocs, syncMemory, syncPeople, syncRepos, syncSessions } from './local.ts';
import type { SyncReport } from './report.ts';
import { syncTracker } from './tracker.ts';

export interface SyncOptions {
  gh: GhClient;
  full?: boolean;
  fetch?: boolean;
  log?: (line: string) => void;
}

/** Every sync, in the order `sync all` and the EOD routine run them. Add a new sync here only. */
const SYNCS = {
  repos: (cfg) => syncRepos(cfg),
  github: (cfg, o) => syncGithub(cfg, o.gh, { full: o.full, log: o.log }),
  commits: (cfg, o) => syncCommits(cfg, { fetch: o.fetch }),
  tracker: (cfg) => syncTracker(cfg),
  sessions: (cfg) => syncSessions(cfg),
  docs: (cfg) => syncDocs(cfg),
  memory: (cfg) => syncMemory(cfg),
  people: (cfg) => syncPeople(cfg),
} satisfies Record<string, (cfg: Config, options: SyncOptions) => SyncReport>;

export type SyncName = keyof typeof SYNCS;
export const SYNC_NAMES = Object.keys(SYNCS) as SyncName[];
export const isSyncName = (name: string): name is SyncName => name in SYNCS;

export const runSyncs = (cfg: Config, names: SyncName[], options: SyncOptions): SyncReport[] =>
  names.map((name) => SYNCS[name](cfg, options));
