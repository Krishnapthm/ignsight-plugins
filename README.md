# Ignsight plugins

This repository is the plugin marketplace for Ignsight.

The `ignsight` plugin records how you use your coding agent during an Ignsight assessment. It records your prompts, the agent replies, tool calls, shell commands, file changes and test runs. It records only in your assignment folder, and only while your assessment is active. It does not record your screen. It removes secrets on your computer before it sends data.

Current version: **0.1.2**

## Supported agents

| Agent | Status | Install | Connect | Update |
| --- | --- | --- | --- | --- |
| [Claude Code](#claude-code) | Supported | [Install](#claude-code-install) | [Connect](#claude-code-connect) | [Update](#claude-code-update) |
| [Cursor](#cursor) | Supported with the Claude Code extension | [Install](#cursor-install) | [Connect](#cursor-connect) | [Update](#cursor-update) |
| [Codex](#codex) | Supported | [Install](#codex-install) | [Connect](#codex-connect) | [Update](#codex-update) |

The Cursor agent (the AI chat that Cursor supplies) is not supported. In Cursor, use the Claude Code extension.

## Before you start

You must have:

- [Node.js](https://nodejs.org/) 24 or later. The plugin uses Node.js to run.
- An invitation to an Ignsight assessment. You get your pairing code from the candidate portal.
- Your assignment folder. Do not use your home folder. The plugin does not connect in your home folder.

To check your Node.js version, run this command:

```sh
node --version
```

## Claude Code

### Claude Code: install

1. Open a terminal.
2. Add the Ignsight marketplace:

   ```sh
   claude plugin marketplace add Krishnapthm/ignsight-plugins
   ```

3. Install the plugin:

   ```sh
   claude plugin install ignsight@ignsight
   ```

4. Close all Claude Code sessions that are open.

### Claude Code: connect

Do these steps after you sign in to the candidate portal.

1. Open a terminal in your assignment folder.
2. Start Claude Code:

   ```sh
   claude
   ```

3. In the candidate portal, copy the pairing code for Claude Code.
4. In Claude Code, send this prompt. Replace `<code>` with your pairing code.

   ```text
   /ignsight:connect <code>
   ```

5. Make sure that Claude Code shows `Paired Claude Code in <folder> with attempt <id>.`
6. Make sure that the candidate portal shows that Claude Code is connected.

A pairing code is for one use only. It expires after 5 minutes. If the code does not work, get a new code from the candidate portal.

To see the connection status, send `/ignsight:status`.

### Claude Code: update

1. Get the latest marketplace data:

   ```sh
   claude plugin marketplace update ignsight
   ```

2. Update the plugin:

   ```sh
   claude plugin update ignsight@ignsight
   ```

3. In each open Claude Code session, send `/reload-plugins`. Or, start a new session.

An update does not remove your connection. You do not have to connect again.

To get updates automatically, send `/plugin` in Claude Code. Go to **Marketplaces**, select `ignsight`, then select **Enable auto-update**.

## Cursor

Use the Claude Code extension in Cursor. The Ignsight plugin works in the extension. The Cursor agent is not supported.

### Cursor: install

1. Install the Claude Code extension in Cursor. Follow the [Claude Code instructions for Cursor](https://code.claude.com/docs/en/vs-code#install-the-extension).
2. Install the Claude Code command-line tool. Follow the [Claude Code setup instructions](https://code.claude.com/docs/en/setup). You use it to install the plugin.
3. In Cursor, open a terminal (**Terminal** > **New Terminal**).
4. Add the Ignsight marketplace:

   ```sh
   claude plugin marketplace add Krishnapthm/ignsight-plugins
   ```

5. Install the plugin:

   ```sh
   claude plugin install ignsight@ignsight
   ```

6. Reload Cursor. Open the Command Palette and run **Developer: Reload Window**.

The extension and the command-line tool use the same plugins. You install the plugin one time for both.

### Cursor: connect

Do these steps after you sign in to the candidate portal.

1. In Cursor, open your assignment folder (**File** > **Open Folder**).
2. Open the Claude Code panel.
3. In the candidate portal, copy the pairing code for Claude Code.
4. In the Claude Code panel, send this prompt. Replace `<code>` with your pairing code.

   ```text
   /ignsight:connect <code>
   ```

5. Make sure that the panel shows `Paired Claude Code in <folder> with attempt <id>.`
6. Make sure that the candidate portal shows that Claude Code is connected.

A pairing code is for one use only. It expires after 5 minutes. If the code does not work, get a new code from the candidate portal.

To see the connection status, send `/ignsight:status`.

### Cursor: update

1. In Cursor, open a terminal.
2. Get the latest marketplace data:

   ```sh
   claude plugin marketplace update ignsight
   ```

3. Update the plugin:

   ```sh
   claude plugin update ignsight@ignsight
   ```

4. Reload Cursor. Open the Command Palette and run **Developer: Reload Window**.

An update does not remove your connection. You do not have to connect again.

## Codex

### Codex: install

1. Open a terminal.
2. Add the Ignsight marketplace:

   ```sh
   codex plugin marketplace add Krishnapthm/ignsight-plugins
   ```

3. Install the plugin:

   ```sh
   codex plugin add ignsight@ignsight
   ```

4. Start Codex. Send `/hooks`, then trust all the Ignsight hooks.
5. Close Codex, then start it again.

You must trust the hooks. If you do not trust them, the plugin cannot connect.

### Codex: connect

Do these steps after you sign in to the candidate portal.

1. Open a terminal in your assignment folder.
2. Start Codex:

   ```sh
   codex
   ```

3. In the candidate portal, copy the pairing code for Codex.
4. In Codex, send this prompt. Replace `<code>` with your pairing code.

   ```text
   $ignsight:connect <code>
   ```

5. Make sure that Codex shows `Paired Codex in <folder> with attempt <id>.`
6. Make sure that the candidate portal shows that Codex is connected.

A pairing code is for one use only. It expires after 5 minutes. If the code does not work, get a new code from the candidate portal.

Use the Codex code in Codex only. Do not use the Claude Code code in Codex.

To see the connection status, send `$ignsight:status`.

### Codex: update

Codex does not have an update command. You must remove the plugin, then install it again.

1. Get the latest marketplace data:

   ```sh
   codex plugin marketplace upgrade ignsight
   ```

2. Remove the plugin:

   ```sh
   codex plugin remove ignsight@ignsight
   ```

3. Install the plugin again:

   ```sh
   codex plugin add ignsight@ignsight
   ```

4. Start Codex. Send `/hooks`, then trust all the Ignsight hooks again. Codex does not run changed hooks until you trust them.
5. Close Codex, then start it again.

An update does not remove your connection. You do not have to connect again.

## Troubleshooting

**The agent replies to the connect prompt, and it tells you that the hooks did not run.**
The plugin did not connect. Your pairing code is not used, so you can try again.

- In Claude Code or Cursor, send `/plugin` and make sure that `ignsight` is enabled.
- In Codex, send `/hooks` and trust all the Ignsight hooks.
- Start a new session in your assignment folder. Then send the connect prompt again.

**The code is not accepted.**
The code is used or expired. Get a new code from the candidate portal.

**The plugin does not connect in your folder.**
Make sure that you are in your assignment folder. The plugin does not connect in your home folder.

**You have an old Ignsight plugin.**
Remove plugins with the names `ignsight-capture` or `interview-trace`. Use only `ignsight`.

```sh
claude plugin uninstall ignsight-capture@ignsight
codex plugin remove ignsight-capture@ignsight
```

**A hook error shows `node: command not found`.**
Install Node.js 24 or later. Then start your agent again.

## Your data

- The plugin records only in the folder that you connect, and only while your assessment is active.
- It does not record files outside that folder. It does not record the content of `.env` files, keys or other credential files.
- It removes secrets, such as tokens and passwords, before it sends data.
- It keeps your connection in your user data folder, not in your assignment folder. It keeps your credential in the system keychain when one is available.

## About this repository

A release workflow publishes the plugin files in `.claude-plugin/`, `.agents/plugins/` and `plugins/ignsight/`. Do not change these files by hand. The next release replaces them. You can change this README directly.
