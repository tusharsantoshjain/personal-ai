import { basename, resolve } from 'node:path';
import type { Config } from '../config.ts';
import type { Segment } from '../shell.ts';
import { isInScratch, isSecretFile, scratchRoot, writeTargetHits } from './paths.ts';
import type { Hit } from './types.ts';

export const READERS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'bat',
  'grep',
  'rg',
  'egrep',
  'sed',
  'awk',
  'source',
  '.',
  'cp',
  'mv',
  'scp',
  'vim',
  'vi',
  'nano',
  'code',
  'open',
  'base64',
  'xxd',
  'strings',
  'sort',
  'uniq',
  'wc',
  'diff',
  'jq',
  'yq',
  'dotenv',
  'curl',
  'tar',
  'zip',
]);
export const AWS_READ =
  /^(get|list|describe|head|wait|filter|lookup|scan|query|batch-get|search|select|estimate|validate|simulate|test|tail|help|ls|start-query|get-query-results)\b/;
export const DB_CLIENTS = ['psql', 'mysql', 'mongo', 'mongosh', 'sqlite3', 'redis-cli', 'cqlsh'];
export const COPY_COMMANDS = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);

/** One simple shell command as the classifiers below see it: `name sub action ...` run in `cwd`. */
export interface ShellCommand {
  argv: string[];
  name: string;
  sub: string;
  action: string;
  seg: Segment;
  cwd: string;
  home: string;
}

export const expandPath = (command: ShellCommand, path: string) =>
  resolve(command.cwd, path.replace(/^~(?=\/|$)/, command.home));
export const operandsOf = (command: ShellCommand) => command.argv.slice(1).filter((x) => !x.startsWith('-'));

export function classifyDelete(cfg: Config, command: ShellCommand): Hit[] {
  const { argv, name, seg } = command;
  if (name === 'find' && (argv.includes('-delete') || (argv.includes('-exec') && /\brm\b/.test(seg.raw))))
    return [{ cat: 'recursive_delete', why: 'find with delete' }];
  if (name === 'pai' && command.sub === 'done')
    return [
      {
        cat: 'recursive_delete',
        why: `pai done ${command.action}: removes that ticket's worktrees and scratch folder`,
      },
    ];
  if (!['rm', 'rmdir', 'rimraf', 'trash'].includes(name)) return [];
  const recursive = name === 'rimraf' || argv.some((x) => x === '--recursive' || /^-[a-zA-Z]*[rR]/.test(x));
  const targets = operandsOf(command);
  const outsideScratch = targets.some((t) => !isInScratch(cfg, expandPath(command, t)));
  return recursive && outsideScratch
    ? [{ cat: 'recursive_delete', why: `recursive delete of ${targets.slice(0, 3).join(' ')}` }]
    : [];
}

export function classifyDatabase(_cfg: Config, { name, seg }: ShellCommand): Hit[] {
  const hits: Hit[] = [];
  if (DB_CLIENTS.includes(name) || (seg.heredocs.length && DB_CLIENTS.some((client) => seg.raw.includes(client)))) {
    const statements = `${seg.raw}\n${seg.heredocs.join('\n')}`;
    if (
      /\b(drop\s+(table|database|schema|index|collection)|truncate(\s+table)?\s+\w|delete\s+from\s+\w+\s*(;|$)|flushall|flushdb|dropDatabase\(|\.drop\(\)|deleteMany\(\s*\{\s*\}\s*\))/im.test(
        statements,
      )
    )
      hits.push({ cat: 'db_destructive', why: 'destructive database statement' });
  }
  if (
    /\b(flywayClean|dropAll|db:drop|migrate\s+reset|db\s+reset)\b/.test(seg.raw) ||
    (name === 'liquibase' && /drop-all|dropAll/.test(seg.raw))
  )
    hits.push({ cat: 'db_destructive', why: 'schema reset or drop' });
  return hits;
}

export function classifyAws({ argv, sub: service, action: operation, seg }: ShellCommand): Hit[] {
  const revealsSecret =
    (service === 'ssm' && /^get-parameters?(-by-path)?$/.test(operation) && argv.includes('--with-decryption')) ||
    (service === 'secretsmanager' && operation === 'get-secret-value') ||
    (service === 'configure' && operation === 'get' && /secret|key|token/i.test(argv[3] ?? '')) ||
    (!seg.nested &&
      ((service === 'ecr' && operation === 'get-login-password') ||
        (service === 'codeartifact' && operation === 'get-authorization-token')));
  if (revealsSecret) return [{ cat: 'secret_read', why: `aws ${service} ${operation} reveals a secret value` }];
  const changesSecret =
    (service === 'ssm' && /^(put|delete|label)-parameter/.test(operation)) ||
    ((service === 'secretsmanager' || service === 'kms') && !AWS_READ.test(operation)) ||
    (service === 'iam' && /access-key|login-profile|password/.test(operation) && !AWS_READ.test(operation)) ||
    (service === 'configure' && operation === 'set');
  if (changesSecret) return [{ cat: 'secrets_change', why: `aws ${service} ${operation}` }];
  if (service === 's3') {
    if (['rm', 'mb', 'rb'].includes(operation)) return [{ cat: 'cloud_write', why: `aws s3 ${operation}` }];
    if (!['cp', 'mv', 'sync'].includes(operation)) return [];
    const destination =
      argv
        .slice(3)
        .filter((x) => !x.startsWith('-'))
        .pop() ?? '';
    return destination.startsWith('s3://') || operation === 'mv'
      ? [{ cat: 'cloud_write', why: `aws s3 ${operation} to ${destination}` }]
      : [];
  }
  return operation && !AWS_READ.test(operation) && !['sts', 'sso', 'configure', 'help'].includes(service)
    ? [{ cat: 'cloud_write', why: `aws ${service} ${operation}` }]
    : [];
}

export function classifyCloud(_cfg: Config, command: ShellCommand): Hit[] {
  const { argv, name, sub, action } = command;
  const write = (why: string): Hit[] => [{ cat: 'cloud_write', why }];
  if (name === 'aws') return classifyAws(command);
  if (
    ['tofu', 'terraform', 'terragrunt'].includes(name) &&
    ['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock'].includes(sub)
  )
    return write(`${name} ${sub}`);
  if (
    ['tofu', 'terraform'].includes(name) &&
    sub === 'state' &&
    ['rm', 'mv', 'push', 'replace-provider'].includes(action)
  )
    return write(`${name} state ${action}`);
  if (name === 'cdk' && ['deploy', 'destroy', 'bootstrap'].includes(sub)) return write(`cdk ${sub}`);
  if (
    ['sam', 'eb', 'serverless', 'sls', 'copilot', 'amplify'].includes(name) &&
    /deploy|delete|destroy|terminate|remove|publish/.test(`${sub} ${action}`)
  )
    return write(`${name} ${sub}`);
  if (
    name === 'kubectl' &&
    /^(apply|delete|create|replace|patch|scale|rollout|edit|drain|cordon|taint|label|annotate|set)$/.test(sub)
  )
    return write(`kubectl ${sub}`);
  if (name === 'helm' && /^(install|upgrade|uninstall|delete|rollback)$/.test(sub)) return write(`helm ${sub}`);
  if (
    (name === 'gcloud' || name === 'az') &&
    argv.some((x) => /^(create|delete|update|deploy|set|add|remove|start|stop)$/.test(x))
  )
    return write(`${name} write`);
  return [];
}

export function classifyPublish(_cfg: Config, { argv, name, sub, action }: ShellCommand): Hit[] {
  const publishes =
    (['npm', 'yarn', 'pnpm', 'bun'].includes(name) &&
      (['publish', 'unpublish', 'deprecate'].includes(sub) || (sub === 'dist-tag' && action !== 'ls'))) ||
    ((name === 'gradle' || name === 'gradlew') && argv.some((x) => /^:?([\w-]+:)*publish\w*$/.test(x))) ||
    (name === 'mvn' && argv.includes('deploy')) ||
    (name === 'twine' && sub === 'upload') ||
    (['poetry', 'cargo'].includes(name) && sub === 'publish') ||
    (name === 'gem' && sub === 'push') ||
    (name === 'docker' && (sub === 'push' || (sub === 'image' && action === 'push')));
  return publishes ? [{ cat: 'package_publish', why: `${name} ${sub} publishes a package` }] : [];
}

export function classifySecretRead(_cfg: Config, { argv, name, sub, seg, home }: ShellCommand): Hit[] {
  const hits: Hit[] = [];
  if (READERS.has(name) && argv.slice(1).some((x) => !x.startsWith('-') && isSecretFile(x, home)))
    hits.push({
      cat: 'secret_read',
      why: 'reads a secrets file (.env, keys, credentials); ask the owner for the value instead',
    });
  const inputFile = /<\s*(\S+)/.exec(seg.raw)?.[1];
  if (inputFile && isSecretFile(inputFile, home))
    hits.push({ cat: 'secret_read', why: 'redirects a secrets file into a command' });
  if (['env', 'printenv', 'export', 'set'].includes(name) && argv.length === 1 && !seg.nested)
    hits.push({ cat: 'secret_read', why: `${name} prints the whole environment, which may hold tokens` });
  if (
    name === 'security' &&
    /find-(generic|internet)-password/.test(sub) &&
    (argv.includes('-w') || argv.includes('-g'))
  )
    hits.push({ cat: 'secret_read', why: 'reads a keychain password' });
  return hits;
}

// shortcut: only redirects, tee and the last operand of cp/mv/install/ln/rsync are seen as write targets; sed -i, scripts and paths built from loop or computed variables are not (plain `S=/path` assignments are followed).
export function classifyWriteTargets(cfg: Config, command: ShellCommand): Hit[] {
  const hits: Hit[] = [];
  const operands = operandsOf(command);
  const outputFiles = [...command.seg.redirects, ...(command.name === 'tee' ? operands : [])];
  const copyTargets = COPY_COMMANDS.has(command.name) ? operands.slice(-1) : [];
  for (const target of [...outputFiles, ...copyTargets]) {
    if (/^\/dev\//.test(target) || /^&?\d$/.test(target)) continue;
    if (target.includes('$')) continue; // built from a variable the gate could not resolve: its real place is unknown
    const abs = expandPath(command, target);
    hits.push(...writeTargetHits(cfg, abs, command.home));
    const looksLikeToolOutput =
      /\.(log|out|txt|lint|xml|json)$/.test(abs) &&
      /(log|lint|out|build|test|report|result|diff|eslint|tsc|sonar)/i.test(basename(abs));
    if (
      outputFiles.includes(target) &&
      abs.startsWith(cfg.paths.workspace + '/') &&
      !isInScratch(cfg, abs) &&
      looksLikeToolOutput
    )
      hits.push({ cat: 'scratch_location', why: `output file ${target} belongs in ${scratchRoot(cfg)}/<TICKET>/` });
  }
  return hits;
}

/** Classifiers for every command that is not git or gh. Add a new kind of risk as one more entry. */
export const SHELL_CLASSIFIERS = [
  classifyDelete,
  classifyDatabase,
  classifyCloud,
  classifyPublish,
  classifySecretRead,
  classifyWriteTargets,
];

export function classifyOther(cfg: Config, argv: string[], seg: Segment, cwd: string, home: string): Hit[] {
  const [name = '', sub = '', action = ''] = argv;
  const command: ShellCommand = { argv, name, sub, action, seg, cwd, home };
  return SHELL_CLASSIFIERS.flatMap((classifier) => classifier(cfg, command));
}
