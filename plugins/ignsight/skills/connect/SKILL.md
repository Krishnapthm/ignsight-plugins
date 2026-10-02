---
name: connect
description: Pair this workspace with an Ignsight assessment using a pairing code from the candidate portal.
argument-hint: <pairing code>
---

Pair the current directory with the candidate's Ignsight assessment attempt. Run
exactly one command from the assignment workspace's root directory, passing the
pairing code the candidate gave (it starts with `ignsight1_`): $ARGUMENTS

Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` below with the installed plugin
root. In Codex, use the directory that contains this skill's `skills/` folder.

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" pair "<pairing code>"
```

Report the command's output to the candidate verbatim and do nothing else. If
it fails, show the error and suggest getting a fresh code from the candidate
portal: codes are single use and expire after five minutes. Never print,
store or reuse the code anywhere else.
