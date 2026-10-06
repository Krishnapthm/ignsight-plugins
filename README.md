# Ignsight plugins

This is the plugin marketplace for Ignsight. The `ignsight` plugin records how you use your coding agent during an Ignsight assessment. It records only in your assignment folder, and only while your assessment is active. It removes secrets on your computer before it sends data.

You need [Node.js](https://nodejs.org/) 24 or later.

| Agent | Status |
| --- | --- |
| [Claude Code](#claude-code) | Supported |
| [Codex](#codex) | Supported |

## Claude Code

Add the marketplace:

```sh
claude plugin marketplace add Krishnapthm/ignsight-plugins
```

Install the plugin:

```sh
claude plugin install ignsight@ignsight
```

To update, run both commands, then start a new session:

```sh
claude plugin marketplace update ignsight
claude plugin update ignsight@ignsight
```

To connect, open your assignment folder and send `/ignsight:connect <code>` with the code from the candidate portal.

## Codex

Add the marketplace:

```sh
codex plugin marketplace add Krishnapthm/ignsight-plugins
```

Install the plugin, then start Codex and trust the Ignsight hooks in `/hooks`:

```sh
codex plugin add ignsight@ignsight
```

To update, run these commands, then restart Codex and trust the hooks again in `/hooks`:

```sh
codex plugin marketplace upgrade ignsight
codex plugin remove ignsight@ignsight && codex plugin add ignsight@ignsight
```

To connect, open your assignment folder and send `$ignsight:connect <code>` with the code from the candidate portal.

## If it does not connect

- A code works one time and expires after 5 minutes. Get a new code from the candidate portal.
- If the agent says the hooks did not run, make sure the plugin is enabled (Claude Code) or the hooks are trusted (Codex). Then start a new session and try again.
- Updates keep your connection. You do not need to connect again.
