---
name: reply
description: Draft a long or formal message in the owner's voice. Use for "reply to this", "draft a message/email/comment" when it is more than a few lines.
---

## Steps
1. Identify channel (chat, email, GitHub comment, Jira comment), recipient and the outcome wanted.
2. comms-writer with the context path and channel. Short replies (under five lines) skip this skill: draft from the voice card directly.
3. Run `pai lint text --channel <c>` yourself on the result. Show the draft in one copyable block.
4. Send only after the owner approves (the gate asks for chat_send, email_send, comments). If the owner edits it, add their words to Corrections in the Voice Profile with the date.

## Stop points
Owner approval before sending.

## Report shape
The draft only, then one line: channel and recipient.
