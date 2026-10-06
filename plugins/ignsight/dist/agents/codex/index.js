import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { isInside } from "../../workspace.js";
import { isObject } from "../../trace/event.js";
import { resolveReal, shellCommands } from "../../trace/scope.js";
import { count, counters, shortText, sumUsage } from "../../trace/usage.js";
import { exitOutcome, parseSnakeCaseHook, sameNames, text } from "../snake-case-hook.js";
// Codex adapter (hooks: https://developers.openai.com/codex/hooks).
// Packaging: plugin/.codex-plugin/plugin.json and plugin/hooks/codex.json.
/** Codex hooks the plugin registers (plugin/hooks/codex.json). */
const hooks = sameNames([
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact", "PostCompact",
]);
// Current builds report shell calls as `Bash`; earlier ones used the model-facing names.
const toolKinds = {
    Bash: "shell", shell: "shell", exec_command: "shell", local_shell: "shell", apply_patch: "patch",
};
/** Local shells may return the model-facing terminal envelope rather than an object. */
function terminalResult(response) {
    if (isObject(response))
        return response;
    if (typeof response !== "string")
        return { stdout: response };
    const header = response.slice(0, 1024);
    const exit = /^Process exited with code (-?\d{1,10})$/m.exec(header);
    const wall = /^Wall time: (\d{1,10}(?:\.\d{1,6})?) seconds$/m.exec(header);
    return {
        stdout: response,
        ...(exit && { exit_code: Number(exit[1]) }),
        ...(wall && { duration_ms: Number(wall[1]) * 1000 }),
    };
}
/** Bound native names before scanning delimiters; malformed names remain unattributed. */
function mcpParts(name) {
    if (name.length > 512 || name.includes("\n") || name.includes("\r") || !name.startsWith("mcp__"))
        return;
    const delimiter = name.indexOf("__", 5);
    if (delimiter <= 5 || delimiter + 2 === name.length)
        return;
    const server = name.slice(5, delimiter);
    if (!/^[A-Za-z0-9_]+$/.test(server))
        return;
    return [server, name.slice(delimiter + 2)];
}
/** Unwrap shell argv without losing quoted script boundaries. Limit nested wrappers. */
function readCommands(command, depth = 0) {
    if (depth > 8)
        return [];
    const commands = typeof command === "string" ? shellCommands(command)
        : Array.isArray(command) && command.every((word) => typeof word === "string") ? [command] : [];
    return commands.flatMap((words) => {
        if (!["bash", "zsh", "sh"].includes(basename(words[0] ?? "")))
            return [words];
        const option = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
        return option > 0 ? readCommands(words[option + 1], depth + 1) : [];
    });
}
export const codex = {
    id: "codex",
    producer: "codex",
    displayName: "Codex",
    connectCommand: "$ignsight:connect",
    hooks,
    // UserPromptSubmit input has no prompt-origin field, so every prompt is the candidate's.
    parse: (raw) => parseSnakeCaseHook(raw, hooks, () => "candidate"),
    async extension(raw, input, root) {
        if (!isObject(raw))
            return { usages: [] };
        const usages = [];
        const id = text(raw.tool_use_id ?? raw.call_id);
        const native = text(raw.tool_name) ?? "";
        const starting = input.hookName === "PreToolUse";
        if (starting && native.startsWith("mcp__")) {
            const parts = mcpParts(native);
            const delimiter = parts?.[0] === "codex_apps" ? parts[1].indexOf("__") : -1;
            const connector = parts && delimiter > 0 && delimiter + 2 < parts[1].length
                ? [parts[1].slice(0, delimiter), parts[1].slice(delimiter + 2)] : undefined;
            usages.push({ kind: "mcp_tool", name: connector?.[1] ?? parts?.[1] ?? (native.length > 512 || native.includes("\n") || native.includes("\r") ? "Unattributed" : native),
                server: parts?.[0], connector: connector?.[0], trigger: "agent", tool_call_id: id,
                vendor: native.length <= 512 ? { tool_name: native } : undefined });
        }
        let withholdToolContent = false;
        if (toolKinds[native] === "shell" && isObject(raw.tool_input)) {
            const command = raw.tool_input.command ?? raw.tool_input.cmd;
            const base = typeof raw.tool_input.workdir === "string" ? resolve(input.cwd, raw.tool_input.workdir) : input.cwd;
            for (const words of readCommands(command)) {
                if (!["cat", "sed", "nl", "head"].includes(words[0] ?? ""))
                    continue;
                if (words[0] === "sed" && !(words[1] === "-n" && /^\d+(?:,\d+)?p$/.test(words[2] ?? "")))
                    continue;
                if (words[0] === "nl" && words[1] !== "-ba")
                    continue;
                for (const path of words.slice(1)) {
                    if (basename(path) !== "SKILL.md")
                        continue;
                    const expanded = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
                    const resolved = resolve(base, expanded);
                    const plugin = /(?:^|\/)plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
                    const name = plugin?.[2] ?? basename(dirname(resolved));
                    if (!name)
                        continue;
                    if (!isInside(await resolveReal(resolved), root))
                        withholdToolContent = true;
                    if (starting)
                        usages.push({ kind: "skill", name, plugin: plugin?.[1], trigger: "agent", tool_call_id: id });
                }
            }
        }
        if (input.hookName === "UserPromptSubmit" && input.promptOrigin === "candidate" && typeof raw.prompt === "string") {
            for (const match of raw.prompt.matchAll(/\$([a-z0-9-]+(?::[a-z0-9-]+)?)/g)) {
                const parts = match[1].split(":");
                usages.push({ kind: "skill", name: parts.at(-1), plugin: parts.length > 1 ? parts[0] : undefined, trigger: "candidate" });
            }
        }
        return { usages, withholdToolContent };
    },
    toolKind: (name) => toolKinds[name] ?? "other",
    shellOutcome({ response }) {
        const result = terminalResult(response);
        // A result without an exit code stays errored: Codex has no success-only hook signal.
        const { exitCode, status } = exitOutcome(result);
        const stdout = text(result.stdout ?? result.output), stderr = text(result.stderr);
        return {
            exitCode, status, stdout, stderr,
            durationMs: typeof result.duration_ms === "number" ? result.duration_ms : undefined,
            testOutput: [stdout, stderr],
        };
    },
    readUsage(input) {
        let usage;
        return {
            add(record, cursor) {
                if (!isObject(record))
                    return;
                if (record.type === "turn_context" && isObject(record.payload)) {
                    cursor.model = shortText(record.payload.model);
                    cursor.effort = shortText(record.payload.effort ?? record.payload.reasoning_effort);
                    return;
                }
                if (record.type !== "event_msg" || !isObject(record.payload) || record.payload.type !== "token_count" || !isObject(record.payload.info))
                    return;
                const info = record.payload.info;
                if (!isObject(info.last_token_usage))
                    return;
                const model = cursor.model ?? shortText(input.model);
                const next = model && counters(info.last_token_usage, model, "cached_input_tokens", undefined, true);
                if (!next)
                    return;
                // input_tokens includes cached input; normalize to uncached input plus cache reads.
                if (next.cache_read_tokens !== undefined) {
                    if (next.cache_read_tokens > next.input_tokens)
                        return;
                    next.input_tokens -= next.cache_read_tokens;
                }
                if (isObject(info.total_token_usage)) {
                    const total = info.total_token_usage;
                    if (count(total.input_tokens) !== undefined && count(total.output_tokens) !== undefined) {
                        const signature = `${total.input_tokens}:${total.output_tokens}:${count(total.cached_input_tokens) ?? ""}`;
                        if (signature === cursor.totals)
                            return; // Rate-limit updates can repeat the latest usage.
                        cursor.totals = signature;
                    }
                }
                cursor.window = count(info.model_context_window) ?? cursor.window;
                next.context_window = cursor.window;
                next.reasoning_effort = cursor.effort;
                usage = sumUsage(usage, next);
            },
            total: () => usage,
        };
    },
    blockPrompt: (message) => ({ decision: "block", reason: message }),
};
