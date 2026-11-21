---
name: release
description: Prepare a release. Use for "prepare the release for <repo>", "release notes for <repo>", "what goes into <version>", "downmerge check", "pre-deployment checklist".
---

## Steps
1. Intake: repo, base branch, release branch and version if any, window start (last release date or tag; ask if unknown). `pai run start release <repo>-<version>`.
2. Facts: `pai sync github` for fresh PR notes, then `pai release notes <repo> --since <date> --base <base> --version <v>`. Fix version gaps: ask tracker-scout for the listed tickets if they are not synced.
3. Branch check (when there is a release branch): `pai release check <repo> --release <branch> --base <base>`. Missing downmerges and wrong-base PRs become checklist items; the owner decides each.
4. Deploy checklist (production deploys): `pai release checklist <path-to-PRE_DEPLOYMENT_CHECKLIST.md> --name <app>-<date>`. Never read or copy SSM or secret values; the owner ticks items.
5. Notes: write release notes from the facts only, grouped by ticket, simple everyday English in outcome words (what changed for users), no PR titles or file names. Run `pai lint text --channel doc`. `pai release notes ... --write` stores the facts note in `03-Projects/Releases/`; put the plain-words notes under it.
6. Show the owner the notes, the fix version issues and the branch checklist. Nothing is posted, retargeted, merged or downmerged without the owner.

## Stop points
Unknown window start or version. Every retarget, downmerge, tracker edit or post (the gate asks).

## Report shape
`Release <repo> <version>: N PRs, M tickets.` / `Fix version issues:` / `Downmerge:` / `Retarget:` / `Notes:` link
