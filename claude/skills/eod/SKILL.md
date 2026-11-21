---
name: eod
description: End of day write-back. Use for "end of day", "wrap up", "eod".
---

## Steps
1. `pai sync all`, `pai prs`, `pai now`.
2. curator writes `/Users/tushar/Developer/ObsidianCore/21-Timeline/Daily/<YYYY-MM-DD>.md` from the Daily template: what happened (`pai timeline show --days 1`), completed, decisions, blockers, follow-ups, new knowledge, KPI evidence, tomorrow's priorities (ask the owner if unclear).
3. `pai lint vault`, then commit the vault (`git -C /Users/tushar/Developer/ObsidianCore add -A && git -C /Users/tushar/Developer/ObsidianCore commit -m "EOD <date>"`, the gate asks).

## Stop points
Vault commit approval.

## Report shape
Five lines: done today, open, blockers, tomorrow, commitments due.
