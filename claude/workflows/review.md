# Review a PR (workflow)

Not installed as a skill because `review` clashes with a built-in command. Use for "review PR <x>", "review all my open PRs", "review this against our guidelines".

## Steps
1. `pai run start review <repo>#<n>`.
2. code-reviewer with only the repo, PR number and ticket key. For several PRs, waves of 2.
3. Turn findings into review comments in the owner's review voice (`Non-blocking:` prefix for non-blocking, file:line, expected fix), lint each with `pai lint text --channel github_comment`.
4. Create a pending review only (GitHub API POST `/repos/<o>/<r>/pulls/<n>/reviews` without `event`; the gate asks). Never publish or approve; the owner submits.
5. `pai record review-given "<summary>" --on <repo>#<n> --with <author>`.

## Report shape
`Blocking: N, Non-blocking: N.` / one line per finding / `Pending review: <link>`
