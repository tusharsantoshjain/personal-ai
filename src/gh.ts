import { execFileSync } from 'node:child_process';

/** Minimal GitHub access through the gh CLI. Tests pass a fake with canned JSON. */
export interface GhClient {
  json<T = unknown>(login: string, args: string[]): T;
}

export class GhError extends Error {}

const TRANSIENT = /timeout|ETIMEDOUT|ECONNRESET|502|503|504|rate limit|secondary rate|EAI_AGAIN|connection reset/i;

export class RealGh implements GhClient {
  private tokens = new Map<string, string>();
  private token(login: string): string {
    let t = this.tokens.get(login);
    if (!t) {
      try {
        t = execFileSync('gh', ['auth', 'token', '--user', login], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        throw new GhError(`gh has no token for ${login}; run \`gh auth login\` as ${login}`);
      }
      this.tokens.set(login, t);
    }
    return t;
  }
  json<T>(login: string, args: string[]): T {
    const env = { ...process.env, GH_TOKEN: this.token(login), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = execFileSync('gh', args, {
          encoding: 'utf8',
          env,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        });
        return (out.trim() ? JSON.parse(out) : null) as T;
      } catch (e) {
        lastErr = e;
        const msg = `${(e as { stderr?: string }).stderr ?? ''} ${(e as Error).message}`;
        if (!TRANSIENT.test(msg)) break;
        // secondary rate limits need a real pause; network blips do not
        execFileSync('sleep', [String(/rate limit/i.test(msg) ? 30 * (attempt + 1) : 2 ** attempt * 2)]);
      }
    }
    const err = lastErr as { stderr?: string; message: string };
    throw new GhError(
      `gh ${args.slice(0, 3).join(' ')} failed for ${login}: ${(err.stderr || err.message).trim().split('\n')[0]}`,
    );
  }
}

export interface SearchPr {
  repository: { nameWithOwner: string; name: string };
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  updatedAt: string;
  state?: string;
  author?: { login: string };
}

export const SEARCH_FIELDS = 'repository,number,title,url,isDraft,updatedAt,state,author';

/** PRs in one org where `login` has a role (`--author`, `--review-requested`, ...), narrowed by extra search filters. */
export function searchPrs(
  gh: GhClient,
  login: string,
  org: string,
  roleFlag: string,
  filters: string[],
  limit: number,
): SearchPr[] {
  return (
    gh.json<SearchPr[]>(login, [
      'search',
      'prs',
      roleFlag,
      login,
      '--owner',
      org,
      ...filters,
      '--json',
      SEARCH_FIELDS,
      '--limit',
      String(limit),
    ]) ?? []
  );
}

export const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{id databaseId author{login} body createdAt url}}}}}}}`;

export interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: {
    nodes: {
      id: string;
      databaseId: number;
      author: { login: string } | null;
      body: string;
      createdAt: string;
      url: string;
    }[];
  };
}

export function reviewThreads(gh: GhClient, login: string, repo: string, n: number): Thread[] {
  const [owner, name] = repo.split('/');
  const r = gh.json<{ data: { repository: { pullRequest: { reviewThreads: { nodes: Thread[] } } } } }>(login, [
    'api',
    'graphql',
    '-f',
    `query=${THREADS_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `n=${n}`,
  ]);
  return r?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}
