---
name: fix
description: Fix a bug the team's way and raise a draft PR. Use for "fix <TICKET>", "fix this bug", "fix it and raise a draft PR".
---

## Steps
1. Intake: ticket (tracker-scout), fix version, base branch per the profile, repo card. `pai run start fix <TICKET>`.
2. Retrieve memory: `pai find <TICKET>`, related decisions, Review Lessons (Plan checks), repo policies.
3. Investigate: bug-investigator with ticket, repo, base. Get root cause, repro, every same-problem site.
4. Plan gate: root cause (file:line), files, regression test, risk, base, delivery, PR size, out-of-scope sites. Wait for the owner's yes. `pai record decision` for the owner's picks.
5. Worktree: `git -C <repo> worktree add ../<repo>-wt-<TICKET> -b <branch> --no-track origin/<base>`.
6. Implement: implementer in the worktree with the approved plan.
7. Validate: regression-guard. Red means fix and re-run; never commit red.
8. Review own diff, then commit (small logical commits, format per profile, no attribution; the gate asks).
9. Push and draft PR only if the profile allows for this project (default: the owner pushes unless asked; ask). PR body from the team template with Notes for reviewers listing out-of-scope sites.
10. Fresh code-reviewer on the PR and ticket only. Fix Blocking and High, re-validate, push.
11. Tracker: comment with the PR link (approval), RCA field in plain words if it is a bug.
12. Record: `pai record` (decision, review-received), run steps done, delete `.scratch/<TICKET>/` logs.
13. Report.

After each step: `pai run step <run> <step> done --next <next>`; on error `failed` with the reason.

## Stop points
- Plan gate (always). Any approval the gate asks for. Validation red after two attempts. Confidence too low on root cause.

## Report shape
```
Fixed <what>.
Root cause: <one line, file:line>.
Changes:
- <change>
- Added regression test <name>
Validation: <tests N passed (base comparison), type-check, lint>
Draft PR: <link>
```
