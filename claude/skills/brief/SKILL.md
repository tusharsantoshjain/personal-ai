---
name: brief
description: What needs my attention, morning brief, daily brief. Use for "what needs my attention", "brief me", "what's on today".
---

## Steps
1. Run `pai prs` (refreshes the PR snapshot; network) and `pai now`.
2. Read `/Users/tushar/Developer/ObsidianCore/01-Dashboard/Now.md` (Pinned and Generated), `pai run show` for open runs, `pai timeline show --days 2 --type commitment`.
3. If the tracker matters today, ask tracker-scout for the owner's open tickets (projects in `tracker.projects`) changed in the last 2 days.
4. Answer in the daily brief shape. Needs attention first, each line with a link. Only actionable items; no PR titles where outcome words work.

## Stop points
None. Read-only.

## Report shape
```
Needs attention
- ...
Completed
- ...
Meetings
- ask the owner (calendar not connected)
Risks
- ...
Upcoming
- ...
```
