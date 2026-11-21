# personal-ai

Engine for a personal work assistant on Claude Code, with an Obsidian vault as memory. Generic: nothing personal lives here. Identity, company rules, voice and people live in the profile file named in `config/assistant.yaml` (outside this repo).

New here? Start with [docs/architecture.md](docs/architecture.md): how data flows, how the gate works, the routines and the dashboards.

## Layout

| Path | What |
| --- | --- |
| `bin/pai` | CLI entry (`node src/cli.ts`); `src/cli.ts` holds one table entry per command |
| `bin/hook` | Claude Code hook entry for PreToolUse, PostToolUse (AskUserQuestion), SubagentStop, SessionStart. A bash regex prefilter skips Node for calls that cannot matter; PreToolUse fails closed |
| `src/config.ts` | Loads and validates `config/assistant.yaml` |
| `src/vault.ts`, `src/secrets.ts` | Path validator, atomic writes, frontmatter, sync blocks, secret scan |
| `src/gate/`, `src/shell.ts`, `src/hook.ts` | Action classifier (one file per kind of call: `git`, `gh`, other shell commands, file tools, connectors; `decide.ts` for levels and approvals), shell parser, chat approvals, agent cap, log |
| `src/text.ts` | Writing filter (dashes, attribution, hard wraps, slop, length) |
| `src/timeline.ts`, `src/runs.ts`, `src/notes.ts` | Timeline ledger, run state, find, resolve, record |
| `src/sync/*` | GitHub, tracker (from connector dumps), sessions, docs, memory, people, repos |
| `src/routines.ts`, `src/schedule.ts` | Scheduled brief, EOD and weekly routines (launchd); schedule and the missed-run warning shown at session start |
| `src/promote.ts`, `src/loose.ts` | Daily note bullets to ticket logs and repo traps (EOD); unpushed, uncommitted and draft work for Now.md (`pai loose-ends`) |
| `src/done.ts` | `pai done <ticket>`: removes a finished ticket's worktrees and scratch folder, keeping anything uncommitted or unpushed |
| `src/dash.ts`, `src/style.ts` | `pai dash`: the whole desk on one terminal screen; colour and status marks for terminal output (plain text into pipes and files) |
| `src/prs.ts`, `src/now.ts`, `src/stats.ts`, `src/lint.ts`, `src/setup.ts` | PR digest, Now.md, usage stats, vault lint, install and doctor |
| `claude/agents`, `claude/skills` | Subagents and skills, linked into the workspace `.claude/` by `pai install` |
| `config/assistant.example.yaml` | Config schema with comments; copy to `assistant.yaml` (gitignored) |
| `logs/hooks.jsonl` | Every ask, deny, approval and grant. Tests and `pai doctor` log to `PAI_LOGS_DIR` instead |
| `.githooks/pre-commit` | Runs tests and typecheck before each commit; `npm install` turns it on |
| `.prettierrc`, `.editorconfig`, `eslint.config.js` | Formatting (Prettier, every option explicit), editor defaults for every file, lint rules (ESLint not installed yet, see `docs/improvements.md`) |
| `docs/architecture.md` | Diagrams of the data flow, the gate and the routines; the dashboards; what each file does |
| `docs/improvements.md` | Tracker of suggested improvements and decisions already made |
| `docs/scenarios.md` | Scenario checks for routing, agents, policy, memory and writing |

## Use

```
npm install         # also enables the pre-commit check
npm link            # puts `pai` on the PATH; agents and skills call it by name
bin/pai install     # links agents, skills, memory; merges workspace settings
bin/pai doctor      # must print "doctor: clean"
npm test            # node:test on temp vaults
npm run typecheck
npm run format      # Prettier on the whole repo (see .prettierignore); the pre-commit check and CI fail on unformatted code
npm run lint        # ESLint (eslint.config.js)
```

## How the gate works

1. `bin/hook` gets the event on stdin. Harmless Bash, Read and connector reads exit before Node starts.
2. `classify` splits the shell command (quotes, heredocs, `$(...)`, `bash -c`, `cd`) and maps each part to categories such as `git_push_protected`, `gh_pr_create_draft`, `text_dash`, `secret_read`.
3. `decide` takes the strictest level: `never` is denied with the reason; `controlled` asks unless autonomy is `autonomous` and every category is on the allow list.
4. In the main chat a controlled call is denied with an approval key. The model asks the owner with AskUserQuestion, putting `[approval:<key>]` in the question. The PostToolUse hook records an "Approve" answer as a one-time grant (15 minutes); the retried identical call consumes it. For an edit to one Google Drive file the question also offers "Approve this file for the session", which lets later edits to that same file run without asking (sharing, trashing and clearing always ask). Subagents get the normal permission prompt.
5. Any error, unreadable input or invalid config makes PreToolUse ask (fail closed). A missing or crashing Node also asks.

## Limits (deliberate, with upgrade paths)

- The note index is rebuilt per call; cache it if the vault passes about 10k notes.
- The shell parser is conservative, not POSIX complete. Unknown shapes fall through to Claude Code's own permission rules.
- The running-agent counter relies on SubagentStop; entries expire after 2 hours. `pai agents reset` clears it.
- The tracker sync renders connector JSON saved to `<cache>/tracker/`; the CLI cannot call connectors itself.
