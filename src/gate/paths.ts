import { basename, join, normalize } from 'node:path';
import type { Config } from '../config.ts';
import type { Hit } from './types.ts';

export const isSecretFile = (p: string, home: string) => {
  const b = basename(p);
  if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist)$/.test(b)) return true;
  if (
    b === '.envrc' ||
    b === '.netrc' ||
    b === '.pgpass' ||
    /^id_(rsa|ed25519|ecdsa|dsa)$/.test(b) ||
    /\.(pem|p12|pfx|key)$/.test(b)
  )
    return true;
  const abs = normalize(p.replace(/^~(?=\/|$)/, home));
  return (
    abs === join(home, '.npmrc') ||
    abs === join(home, '.aws', 'credentials') ||
    abs.startsWith(join(home, '.ssh') + '/')
  );
};

export const scratchRoot = (cfg: Config) => join(cfg.paths.workspace, '.scratch');
export const isInScratch = (cfg: Config, abs: string) =>
  abs === scratchRoot(cfg) || abs.startsWith(scratchRoot(cfg) + '/') || abs.startsWith(cfg.paths.cache_dir + '/');

export const configFiles = (cfg: Config, home: string) => [
  join(cfg.paths.workspace, '.claude', 'settings.json'),
  join(cfg.paths.workspace, '.claude', 'settings.local.json'),
  join(home, '.claude', 'settings.json'),
  join(cfg.paths.assistant_repo, 'config', 'assistant.yaml'),
];

/** Checks on where a write lands. Shared by the file tools and shell writes (redirects, tee, cp, mv). */
export function writeTargetHits(cfg: Config, abs: string, home: string): Hit[] {
  const hits: Hit[] = [];
  const frozen = cfg.approvals.frozen_paths.find((f) => abs.includes(f.pattern));
  if (frozen) hits.push({ cat: 'frozen_edit', why: `${abs} is frozen: ${frozen.reason}` });
  if (abs.startsWith(join(cfg.paths.vault, '.claude', 'worktrees') + '/'))
    hits.push({
      cat: 'frozen_edit',
      why: `${abs} is a worktree copy of the vault; notes written there never reach ${cfg.paths.vault}`,
    });
  if (
    abs.startsWith(join(cfg.paths.cache_dir, 'approvals')) ||
    abs.startsWith(join(cfg.paths.cache_dir, 'state')) ||
    abs.startsWith(cfg.paths.logs_dir + '/')
  )
    hits.push({ cat: 'approval_forgery', why: 'writes to the gate state, approvals or hook log' });
  if (configFiles(cfg, home).includes(abs))
    hits.push({ cat: 'config_edit', why: `edits ${basename(abs)} (permissions, hooks or assistant config)` });
  if (ENGINE_FOLDERS.some((folder) => abs.startsWith(join(cfg.paths.assistant_repo, folder) + '/')))
    hits.push({ cat: 'engine_edit', why: `edits the assistant engine (${basename(abs)}), which includes this gate` });
  if (isSecretFile(abs, home)) hits.push({ cat: 'secrets_change', why: 'writes a secrets file' });
  return hits;
}

export const ENGINE_FOLDERS = ['src', 'bin', '.githooks'];
