# Improvement tracker

Suggested improvements that are not done yet, and decisions already made so they are not raised again. Add a row when an idea comes up; move it to Decided or delete it when it ships.

Status: `todo` ready to pick up, `blocked` needs something first, `parked` deliberately left for later.

## Open

| # | Improvement | Status | Why it matters | What it needs |
| --- | --- | --- | --- | --- |
| 1 | Prompt scenario check: a `pai scenarios` command that runs a few read-only requests from `docs/scenarios.md` through `claude -p` and checks the transcript for the expected skill, agents and forbidden commands | todo | About 7,000 words of prompts have no automated check; a prompt edit can break routing unnoticed | Owner's go-ahead (uses Claude quota each run); run on demand only, about five cheap scenarios |
| 2 | Fetch Jira directly in the tracker sync instead of rendering dumps an agent saves by hand | parked | Ticket notes go stale on days no agent fetched them | Jira access is only on the Claude Code account today; revisit if that changes or an API token is acceptable |
| 3 | Off-machine backup of this repo and the vault | blocked | Both live only on one Mac | Owner creates private remotes. The EOD routine already pushes the vault once it has a remote; CI (`.github/workflows/ci.yml`) starts working once this repo has one |
| 4 | Find out why the routines stopped (last EOD Nov 10, last brief Nov 6) | blocked | Nothing has synced since | Owner runs `launchctl print gui/$(id -u)/com.personal-ai.eod`, then `pai routines install` |
| 5 | Remove personal paths and employer names from `claude/` prompts: workspace, vault and scratch paths in 14 agents and 6 skills; employer rules in the feature and fix skills; the checklist path in the release skill | blocked | The README says nothing personal lives in this repo; the prompts break if a folder moves | The profile (outside this repo) must hold these facts first, or `pai install` must render the prompts from config |
| 10 | Finish ESLint: install it, fix the first findings, then add `npm run lint` to the pre-commit check and CI | parked | `eslint.config.js` and the `lint` script are ready, but ESLint has never run on this code | Owner held off because installing `eslint @eslint/js typescript-eslint` reported vulnerabilities; revisit when `npm audit` is clean for them |
| 6 | Gate: see writes made by `sed -i`, scripts and paths built from `$VARS` | parked | Known limit of the write-target check (`src/gate/shell.ts`) | A real need; a model that tries can still route around a path check |
| 7 | Rotate `logs/hooks.jsonl` | parked | About 280 KB after four weeks; `pai stats` reads the whole file | Only when it gets slow |
| 8 | Cache the note index (`src/notes.ts`) | parked | Rebuilt on every `find` and `resolve` | When the vault passes about 10k notes |
| 9 | Catch unlabelled personal names in scrubbed text (`src/scrub.ts`) | parked | The scrub is label-based | If one shows up in review |

## Decided

| Decision | Date | Reason |
| --- | --- | --- |
| `git_commit` stays `controlled`: the assistant asks before every commit | 2026-11-14 | Owner wants to approve each commit, even though commits are about a third of all approval prompts |
| Tracker sync keeps using connector dumps | 2026-11-14 | See Open #2 |
