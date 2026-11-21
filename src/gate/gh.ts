import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { repoForPath } from '../config.ts';
import type { Segment } from '../shell.ts';
import { flagValues, has, parseJson, readTextFile } from './args.ts';
import { strings, textHits } from './outgoing.ts';
import type { Hit } from './types.ts';

/** `gh api`: REST and GraphQL calls, judged by method, path, query and the outgoing text. */
export function classifyGhApi(cfg: Config, args: string[], cwd: string): Hit[] {
  const hits: Hit[] = [];
  const method = (
    flagValues(args, ['-X', '--method'])[0] ??
    (has(args, '-f', '-F', '--field', '--raw-field', '--input') || args.some((x) => /^-[fF]./.test(x)) ? 'POST' : 'GET')
  ).toUpperCase();
  const path =
    args
      .slice(2)
      .find(
        (x) =>
          !x.startsWith('-') &&
          !/^[\w.[\]]+=/.test(x) &&
          ![
            '-X',
            '--method',
            '-f',
            '-F',
            '--field',
            '--raw-field',
            '-H',
            '--header',
            '--jq',
            '-q',
            '--input',
            '-t',
            '--template',
          ].includes(args[args.indexOf(x) - 1] ?? ''),
      ) ?? '';
  const fields = flagValues(args, ['-f', '-F', '--field', '--raw-field']);
  const field = (k: string) => fields.find((f) => f.startsWith(k + '='))?.slice(k.length + 1);
  for (const v of fields) {
    const val = v.slice(v.indexOf('=') + 1);
    if (val.length > 3) hits.push(...textHits(cfg, val, 'API field', /^body=/.test(v)));
  }
  const inputFile = flagValues(args, ['--input'])[0];
  const inputJson = inputFile && inputFile !== '-' ? parseJson(readTextFile(resolve(cwd, inputFile))) : undefined;
  if (inputJson !== undefined) hits.push(...textHits(cfg, strings(inputJson).join('\n\n'), 'API input file', true));
  if (path === 'graphql') {
    const queryField = field('query');
    const query = queryField?.startsWith('@')
      ? readTextFile(resolve(cwd, queryField.slice(1)))
      : (queryField ?? (inputJson as { query?: unknown } | undefined)?.query);
    if (typeof query !== 'string')
      hits.push({
        cat: 'gh_api_write',
        why: 'GraphQL query not readable (stdin, missing file or not JSON); treated as a write',
      });
    else if (/\bmutation\b/.test(query)) {
      if (/mergePullRequest|enablePullRequestAutoMerge/.test(query))
        hits.push({ cat: 'gh_pr_merge', why: 'GraphQL merge mutation' });
      else if (
        /submitPullRequestReview/.test(query) ||
        (/addPullRequestReview\b/.test(query) && /\bevent\s*:/.test(query))
      )
        hits.push({ cat: 'gh_review_published', why: 'GraphQL mutation publishes a review' });
      else if (/addPullRequestReview(Thread)?\b|addPullRequestReviewComment/.test(query))
        hits.push({ cat: 'gh_review_pending', why: 'GraphQL pending review' });
      else if (/markPullRequestReadyForReview/.test(query))
        hits.push({ cat: 'gh_pr_ready', why: 'GraphQL ready for review' });
      else if (/addComment|addPullRequestReviewThreadReply|resolveReviewThread|unresolveReviewThread/.test(query))
        hits.push({ cat: 'gh_comment', why: 'GraphQL comment or thread change' });
      else hits.push({ cat: 'gh_api_write', why: 'GraphQL mutation' });
    }
  } else if (method !== 'GET' && method !== 'HEAD') {
    if (/\/pulls\/\d+\/merge$/.test(path)) hits.push({ cat: 'gh_pr_merge', why: 'API merge' });
    else if (/\/pulls\/\d+\/reviews\/\d+\/events$/.test(path))
      hits.push({ cat: 'gh_review_published', why: 'API submits a pending review' });
    else if (/\/pulls\/\d+\/reviews$/.test(path) && method === 'POST')
      hits.push(
        field('event')
          ? { cat: 'gh_review_published', why: `API review with event=${field('event')}` }
          : { cat: 'gh_review_pending', why: 'API pending review' },
      );
    else if (/\/(actions\/)?secrets|\/environments\/[^/]+\/secrets|\/variables/.test(path))
      hits.push({ cat: 'secrets_change', why: 'API secrets or variables change' });
    else if (
      /\/(hooks|collaborators|branches\/[^/]+\/protection|rulesets|keys|teams|invitations)\b/.test(path) ||
      (method === 'DELETE' && /^\/?repos\/[^/]+\/[^/]+\/?$/.test(path)) ||
      /^\/?orgs\//.test(path)
    )
      hits.push({ cat: 'gh_admin', why: `API admin change ${method} ${path}` });
    else if (/\/(actions\/workflows\/[^/]+\/dispatches|actions\/runs\/\d+\/(rerun|cancel))/.test(path))
      hits.push({ cat: 'gh_workflow_dispatch', why: 'API workflow dispatch' });
    else if (/\/(issues|pulls)\/(\d+\/)?comments|\/comments\/\d+/.test(path))
      hits.push({ cat: 'gh_comment', why: `API comment ${method}` });
    else if (/\/pulls\/\d+\/requested_reviewers/.test(path))
      hits.push({ cat: 'gh_request_review', why: 'API reviewer request' });
    else hits.push({ cat: 'gh_api_write', why: `API ${method} ${path}` });
  }
  return hits;
}

export function classifyGh(cfg: Config, argv: string[], seg: Segment, cwd: string): Hit[] {
  const hits: Hit[] = [];
  const repoFlag = flagValues(argv, ['-R', '--repo'])[0];
  const args = argv.filter(
    (x, k) =>
      !(x === '-R' || x === '--repo' || argv[k - 1] === '-R' || argv[k - 1] === '--repo' || x.startsWith('--repo=')),
  );
  const [, sub, act] = args;
  const rest = args.slice(3);
  const repo = repoFlag
    ? cfg.repositories.find((r) => r.name.toLowerCase() === repoFlag.split('/').pop()!.toLowerCase())
    : repoForPath(cfg, cwd);
  const titleBodyChecks = () => {
    for (const t of flagValues(rest, ['--title', '-t'])) {
      hits.push(...textHits(cfg, t, 'PR title', false));
      const fmt = repo?.commit_format ? cfg.commit_formats[repo.commit_format] : undefined;
      if (sub === 'pr' && fmt && !new RegExp(fmt.pattern).test(t))
        hits.push({
          cat: 'commit_format',
          why: `PR title "${t.slice(0, 60)}" does not match ${repo!.name} format, e.g. "${fmt.example ?? fmt.pattern}"`,
        });
    }
    for (const b of flagValues(rest, ['--body', '-b']))
      hits.push(
        ...textHits(cfg, /\$\(\s*cat\b|<</.test(b) && seg.heredocs[0] ? seg.heredocs[0] : b, `${sub} body`, true),
      );
  };
  if (sub === 'pr' || sub === 'issue') {
    switch (act) {
      case 'create':
        if (sub === 'pr')
          hits.push(
            has(rest, '--draft', '-d')
              ? { cat: 'gh_pr_create_draft', why: 'gh pr create --draft' }
              : { cat: 'gh_pr_create_ready', why: 'non-draft PR create (always open PRs as draft)' },
          );
        else hits.push({ cat: 'gh_api_write', why: 'gh issue create' });
        if (has(rest, '--reviewer', '-r')) hits.push({ cat: 'gh_request_review', why: 'PR create with reviewers' });
        titleBodyChecks();
        break;
      case 'merge':
        hits.push({ cat: 'gh_pr_merge', why: "merging is the owner's call" });
        break;
      case 'ready':
        hits.push({ cat: 'gh_pr_ready', why: has(rest, '--undo') ? 'mark PR as draft' : 'mark PR ready for review' });
        break;
      case 'close':
      case 'reopen':
      case 'delete':
      case 'lock':
      case 'transfer':
        hits.push({ cat: 'gh_close', why: `gh ${sub} ${act}` });
        break;
      case 'edit':
        if (has(rest, '--base', '-B')) hits.push({ cat: 'gh_pr_retarget', why: 'retarget PR base' });
        if (has(rest, '--add-reviewer', '--remove-reviewer'))
          hits.push({ cat: 'gh_request_review', why: 'change reviewers' });
        if (
          has(
            rest,
            '--title',
            '-t',
            '--body',
            '-b',
            '--body-file',
            '-F',
            '--add-label',
            '--remove-label',
            '--add-assignee',
            '--milestone',
          )
        )
          hits.push({ cat: 'gh_pr_edit', why: `gh ${sub} edit` });
        if (!hits.length) hits.push({ cat: 'gh_pr_edit', why: `gh ${sub} edit` });
        titleBodyChecks();
        break;
      case 'comment':
        hits.push({ cat: 'gh_comment', why: `gh ${sub} comment` });
        titleBodyChecks();
        break;
      case 'review':
        hits.push({
          cat: 'gh_review_published',
          why: 'gh pr review publishes argv review; create argv pending review through the API instead',
        });
        break;
      case 'develop':
        hits.push({ cat: 'gh_api_write', why: 'gh issue develop creates argv branch' });
        break;
    }
  } else if (sub === 'api') {
    hits.push(...classifyGhApi(cfg, args, cwd));
  } else if (sub === 'workflow' && (act === 'run' || act === 'enable' || act === 'disable'))
    hits.push({ cat: 'gh_workflow_dispatch', why: `gh workflow ${act}` });
  else if (sub === 'run' && (act === 'rerun' || act === 'cancel' || act === 'delete'))
    hits.push({ cat: 'gh_workflow_dispatch', why: `gh run ${act}` });
  else if ((sub === 'secret' || sub === 'variable') && act !== 'list')
    hits.push({ cat: 'secrets_change', why: `gh ${sub} ${act}` });
  else if (sub === 'repo' && ['delete', 'edit', 'archive', 'rename', 'unarchive', 'deploy-key'].includes(act ?? ''))
    hits.push({ cat: 'gh_admin', why: `gh repo ${act}` });
  else if (sub === 'ruleset' || sub === 'ssh-key' || sub === 'gpg-key' || (sub === 'label' && act !== 'list'))
    hits.push({ cat: 'gh_admin', why: `gh ${sub} ${act ?? ''}`.trim() });
  else if (sub === 'release' && ['create', 'upload', 'delete', 'edit'].includes(act ?? ''))
    hits.push({ cat: 'package_publish', why: `gh release ${act}` });
  else if (sub === 'auth' && act === 'token' && !seg.nested)
    hits.push({ cat: 'secret_read', why: 'gh auth token prints argv token; use it only inside $(...)' });
  return hits;
}
