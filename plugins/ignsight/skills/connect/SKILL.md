---
name: connect
description: Pair this workspace with an Ignsight assessment using a pairing code from the candidate portal.
---

The Ignsight plugin's prompt hook pairs the workspace as soon as the candidate
submits `/ignsight:connect <code>` (Claude Code) or `$ignsight:connect <code>`
(Codex), and blocks that prompt with the result. If you are reading this, the
hook did not run, so pairing did not happen.

Do not run any pairing command yourself and never print, store or reuse the
code: a coding agent's sandbox can block the pairing store after the
single-use code is spent.

Tell the candidate, briefly:

1. The Ignsight plugin's hooks did not run. In Codex, open `/hooks` and trust
   the Ignsight hooks. In Claude Code, make sure the `ignsight` plugin is
   enabled in `/plugin`.
2. Start a new session in the assignment folder.
3. Get a fresh pairing code from the candidate portal and submit it again as
   `$ignsight:connect <code>` in Codex or `/ignsight:connect <code>` in Claude
   Code. Codes are single use and expire after five minutes.

In Cursor, use /connect. If pairing hooks did not run, enable Ignsight
in /plugin, reload the window, and get a fresh code. After pairing, start
a new chat immediately: blocked prompts remain in chat history.
