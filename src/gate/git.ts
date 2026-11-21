import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { repoForPath } from '../config.ts';
import { tryGit } from '../git.ts';
import type { Segment } from '../shell.ts';
import { flagValues, has, readTextFile, shortFlag } from './args.ts';
import { textHits } from './outgoing.ts';
import type { GitContext, Hit } from './types.ts';

export const gitQuick = (cwd: string, args: string[]) => tryGit(cwd, args, { timeoutMs: 2000 }); // the gate runs on every call
export const realGit: GitContext = {
  branch: (cwd) => gitQuick(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  isMainCheckout: (cwd) => {
    const gitDir = gitQuick(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const commonDir = gitQuick(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return !!gitDir && gitDir === commonDir;
  },
};

export const globMatch = (pattern: string, s: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s);
export const isProtected = (cfg: Config, branch: string) =>
  cfg.github.protected_branches.some((p) => globMatch(p, branch));

export function classifyGit(cfg: Config, argv: string[], seg: Segment, cwd: string, git: GitContext): Hit[] {
  const hits: Hit[] = [];
  let i = 1;
  let wd = cwd;
  while (i < argv.length && argv[i]!.startsWith('-')) {
    if (argv[i] === '-C' && argv[i + 1]) {
      wd = resolve(wd, argv[i + 1]!);
      i += 2;
      continue;
    }
    if (argv[i] === '-c' || argv[i] === '--git-dir' || argv[i] === '--work-tree') {
      i += 2;
      continue;
    }
    i++;
  }
  const sub = argv[i];
  const args = argv.slice(i + 1);
  switch (sub) {
    case 'commit': {
      hits.push({
        cat: has(args, '--amend') ? 'git_amend' : 'git_commit',
        why: has(args, '--amend') ? 'git commit --amend rewrites the last commit' : 'git commit',
      });
      if (has(args, '--no-verify') || shortFlag(args, 'n'))
        hits.push({ cat: 'git_no_verify', why: 'commit skips hooks (--no-verify)' });
      if ((has(args, '-a', '--all') || shortFlag(args, 'a')) && git.isMainCheckout(wd))
        hits.push({ cat: 'git_add_all_main', why: 'commit -argv in argv main checkout (use argv worktree)' });
      const msgs = flagValues(args, ['-m', '--message']);
      let msg = msgs.join('\n\n');
      if (/\$\(\s*cat\b|<</.test(msg) && seg.heredocs.length) msg = seg.heredocs[0]!;
      const messageFile = flagValues(args, ['-F', '--file'])[0];
      if (!msg && messageFile && messageFile !== '-') msg = readTextFile(resolve(wd, messageFile)) ?? '';
      if (msg) {
        hits.push(...textHits(cfg, msg, 'commit message', true));
        const repo = repoForPath(cfg, wd);
        const fmt = repo?.commit_format ? cfg.commit_formats[repo.commit_format] : undefined;
        const subject = msg.split('\n')[0] ?? '';
        if (fmt && !new RegExp(fmt.pattern).test(subject))
          hits.push({
            cat: 'commit_format',
            why: `commit subject "${subject.slice(0, 60)}" does not match ${repo!.name} format, e.g. "${fmt.example ?? fmt.pattern}"`,
          });
        if (fmt?.required_trailer && !new RegExp(fmt.required_trailer, 'm').test(msg))
          hits.push({
            cat: 'commit_format',
            why: `commit in ${repo!.name} needs argv trailer line matching ${fmt.required_trailer}`,
          });
      }
      break;
    }
    case 'push': {
      const force =
        has(args, '--force', '-f') || shortFlag(args, 'f') || args.some((x) => !x.startsWith('-') && x.startsWith('+'));
      const lease = has(args, '--force-with-lease', '--force-if-includes');
      if (force)
        hits.push({
          cat: 'git_force_push',
          why: 'plain force push (use --force-with-lease, and only on your own branch)',
        });
      else if (lease) hits.push({ cat: 'git_force_with_lease', why: 'force-with-lease push' });
      if (has(args, '--no-verify')) hits.push({ cat: 'git_no_verify', why: 'push skips hooks (--no-verify)' });
      const pos = args.filter(
        (x, k) =>
          !x.startsWith('-') &&
          !['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(args[k - 1] ?? ''),
      );
      const refspecs = pos.slice(1);
      if (has(args, '--delete', '-d') || refspecs.some((r) => r.startsWith(':')))
        hits.push({ cat: 'git_branch_delete', why: 'push deletes argv remote branch' });
      if (has(args, '--all', '--mirror', '--tags') && has(args, '--all', '--mirror'))
        hits.push({ cat: 'git_push_protected', why: 'push --all/--mirror can update protected branches' });
      const targets = refspecs.length
        ? refspecs
            .map((r) =>
              r
                .replace(/^\+/, '')
                .split(':')
                .pop()!
                .replace(/^refs\/heads\//, ''),
            )
            .filter(Boolean)
            .map((r) => (r === 'HEAD' ? (git.branch(wd) ?? 'HEAD') : r))
        : [git.branch(wd) ?? 'HEAD'];
      const prot = targets.find((t) => isProtected(cfg, t));
      if (prot) hits.push({ cat: 'git_push_protected', why: `push to protected branch "${prot}"` });
      hits.push({ cat: 'git_push', why: `git push ${targets.join(', ')}` });
      break;
    }
    case 'branch':
      if (has(args, '-d', '-D', '--delete') || shortFlag(args, 'd') || shortFlag(args, 'D'))
        hits.push({ cat: 'git_branch_delete', why: 'local branch delete' });
      break;
    case 'reset':
      if (has(args, '--hard', '--merge', '--keep'))
        hits.push({ cat: 'git_destructive', why: 'git reset --hard discards work' });
      break;
    case 'clean':
      if ((has(args, '--force') || shortFlag(args, 'f')) && !has(args, '-n', '--dry-run') && !shortFlag(args, 'n'))
        hits.push({ cat: 'git_destructive', why: 'git clean -f deletes untracked files' });
      break;
    case 'checkout':
    case 'switch':
      if (
        (sub === 'checkout' && (args.includes('--') || args.includes('.'))) ||
        has(args, '-f', '--force', '--discard-changes')
      )
        hits.push({ cat: 'git_destructive', why: `git ${sub} that overwrites working files` });
      break;
    case 'restore':
      if (!has(args, '--staged', '-S') || has(args, '--worktree', '-W'))
        hits.push({ cat: 'git_destructive', why: 'git restore discards working changes' });
      break;
    case 'stash':
      if (args[0] === 'drop' || args[0] === 'clear') hits.push({ cat: 'git_destructive', why: `git stash ${args[0]}` });
      break;
    case 'worktree':
      if (args[0] === 'remove' && has(args, '--force', '-f'))
        hits.push({ cat: 'git_destructive', why: 'git worktree remove --force' });
      if (args[0] === 'prune') hits.push({ cat: 'git_destructive', why: 'git worktree prune' });
      break;
    case 'add':
      if (
        (has(args, '-A', '--all', '-u', '--update') || args.includes('.') || args.includes(':/')) &&
        git.isMainCheckout(wd)
      )
        hits.push({
          cat: 'git_add_all_main',
          why: 'add-all in argv main checkout (work in argv worktree, or add named files)',
        });
      break;
    case 'filter-branch':
    case 'filter-repo':
      hits.push({ cat: 'git_destructive', why: `git ${sub} rewrites history` });
      break;
    case 'update-ref':
      if (has(args, '-d')) hits.push({ cat: 'git_destructive', why: 'git update-ref -d' });
      break;
  }
  return hits;
}
