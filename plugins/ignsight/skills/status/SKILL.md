---
name: status
description: Show whether Ignsight capture is paired and active for this workspace.
---

Show the Ignsight capture status for the current workspace. Claude Code
substitutes `${CLAUDE_PLUGIN_ROOT}` below with the installed plugin root. In
Codex, use the directory that contains this skill's `skills/` folder.

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status
```

Report the output verbatim: producer, workspace root, attempt ID, state
(`paired`, `waiting for the test to start`, `capturing`, or `ended at <time>`),
valid until, last successful upload, buffered count, credential storage and
last error. If capture has ended, include the end reason and uploaded and
dropped event counts. For machine-readable output, use `status --json`.

Tell the candidate to check the candidate portal for the matching producer
and attempt, such as "Claude Code: paired" or "Codex: paired". The local pairing
and the portal's producer connection should match.
