---
name: pr-feedback
description: Address review comments on the owner's PR. Use for "address the comments on <PR>", "handle review feedback".
---

## Steps
1. `pai run start pr-feedback <repo>#<n>`. pr-feedback agent: verdict per unresolved thread, plan, draft replies.
2. Show the owner the verdict table. Owner confirms which to implement and which to push back on (`pai record pushback` or `decision`).
3. implementer for the valid ones (tests included), regression-guard, commit (approval), push (approval or owner pushes per profile).
4. Post the short replies on each thread (approval; text passes `pai lint text --channel github_comment`). Never resolve threads the reviewer opened unless the owner says so.
5. `pai record review-received` per thread outcome.

## Stop points
Owner confirmation of verdicts; approvals; red validation.

## Report shape
`Addressed N of M threads.` / per thread one line: verdict, change or reply / `Validation:` / `Pushed:`
