---
name: feature
description: Build a feature the team's way. Use for "build <feature>", "implement <TICKET>" when the ticket is a story or task, not a bug.
---

## Steps
Same as the fix skill, with these changes:
1. After intake, run repo-analyst for the area (entry points, flow, contracts, regression surface).
2. Plan gate includes acceptance criteria coverage, contract changes and a PR size check: over about 300 lines means a split plan (team code review rule).
3. Tests cover the acceptance criteria, not coverage numbers.
4. PR body has an Acceptance criteria coverage section and Proof of testing.

## Stop points
Plan gate, approvals, red validation, size over the limit without an agreed split.

## Report shape
`Built <what>.` / `Changes:` / `Acceptance criteria:` covered list / `Validation:` / `Draft PR:`
