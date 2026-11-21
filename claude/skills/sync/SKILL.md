---
name: sync
description: Refresh the vault from GitHub, git, tracker, sessions, docs, memory and people. Use for "refresh the vault", "sync".
---

## Steps
1. Tracker: tracker-scout runs the owner's JQL (assignee was, reporter, watcher, worklog author or text mentions, updated in the last 30 days, fields incl. comment and worklog). The result file is copied to `~/.cache/personal-ai/tracker/`.
2. `pai sync all` (add `--fetch` to fetch remotes first for commit history).
3. `pai now`, `pai lint vault`.

## Stop points
None.

## Report shape
One line per sync: notes changed, events added, errors.
