import { isObject } from "../../trace/event.js";
import { counters, shortText, sumUsage } from "../../trace/usage.js";
import { exitOutcome, parseSnakeCaseHook, sameNames, text } from "../snake-case-hook.js";
// Claude Code adapter (hooks: https://code.claude.com/docs/en/hooks).
// Packaging: plugin/.claude-plugin/plugin.json and plugin/hooks/claude-code.json.
/** Claude Code hooks the plugin registers (plugin/hooks/claude-code.json). */
const hooks = sameNames([
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "UserPromptExpansion", "Stop", "StopFailure", "PreCompact", "PostCompact",
]);
const toolKinds = { Bash: "shell", Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit" };
// Wrapper elements Claude Code submits as the whole prompt of a turn it starts
// itself: a background task reporting back (seen live on 2.1.285), and a
// message from another session (`<cross-session-message from="...">`, from
// the 2.1.285 binary).
const hostWrappers = ["task-notification", "cross-session-message"];
/**
 * Claude Code runs UserPromptSubmit for turns it starts itself, and its hook
 * input has no origin field. A prompt is host-started only when, apart from
 * surrounding whitespace, it is exactly one host wrapper element. Everything
 * else, including a wrapper the candidate typed text around, is the candidate's:
 * the check fails toward candidate. Plain string scans keep this linear-time.
 * Known gap: /loop and scheduled turns are not wrapped, so they read as the
 * candidate's (ISGT-57).
 */
export function promptOrigin(prompt) {
    const trimmed = prompt.trim();
    return hostWrappers.some((tag) => isSingleElement(trimmed, tag)) ? "host" : "candidate";
}
/** `<tag>` or `<tag attributes>`, then a body that neither opens nor closes `tag`, then `</tag>`. */
function isSingleElement(text, tag) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    if (!text.startsWith(open) || !text.endsWith(close))
        return false;
    const openEnd = text.indexOf(">", open.length);
    if (openEnd < 0 || openEnd > text.length - close.length)
        return false;
    const attributes = text.slice(open.length, openEnd);
    if (attributes && (!/^\s/.test(attributes) || attributes.includes("<")))
        return false;
    const body = text.slice(openEnd + 1, text.length - close.length);
    return !body.includes(open) && !body.includes(close);
}
/** Cap untrusted names before delimiter scanning, including malformed multiline names. */
function mcpParts(name) {
    if (name.length > 512 || name.includes("\n") || name.includes("\r") || !name.startsWith("mcp__"))
        return;
    const delimiter = name.indexOf("__", 5);
    if (delimiter <= 5 || delimiter + 2 === name.length)
        return;
    return [name.slice(5, delimiter), name.slice(delimiter + 2)];
}
export const claudeCode = {
    id: "claude-code",
    producer: "claude_code",
    displayName: "Claude Code",
    connectCommand: "/ignsight:connect",
    hooks,
    parse(raw) {
        // Imported hooks must not misattribute another host's work or spend its pairing code.
        // Ambient host variables may be inherited by a genuine native session.
        if (isObject(raw) && (raw.cursor_version !== undefined ||
            (raw.conversation_id !== undefined && raw.generation_id !== undefined && typeof raw.session_id !== "string")))
            return null;
        const input = parseSnakeCaseHook(raw, hooks, promptOrigin, ["custom_instructions", "error_details"]);
        if (input?.hookName === "UserPromptExpansion")
            input.payload = {};
        if (input?.payload.tool_name === "Skill" && isObject(input.payload.tool_input))
            input.payload.tool_input = { skill: input.payload.tool_input.skill };
        return input;
    },
    extension(raw, input) {
        if (!isObject(raw))
            return { usages: [] };
        const usages = [];
        const id = text(raw.tool_use_id);
        const native = text(raw.tool_name) ?? "";
        if (input.hookName === "PreToolUse") {
            const mcp = mcpParts(native);
            if (native.startsWith("mcp__")) {
                let server = mcp?.[0], name = mcp?.[1] ?? "Unattributed", plugin;
                const provenance = isObject(raw.mcp_server) ? raw.mcp_server : {};
                if (mcp && typeof provenance.name === "string" && provenance.name.length <= 512 && !/[\r\n]/.test(provenance.name)) {
                    server = provenance.name;
                    const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
                    if (native.startsWith(prefix))
                        name = native.slice(prefix.length);
                    const parts = /^plugin:([^:]+):(.+)$/.exec(server);
                    if (provenance.source === "plugin" && parts) {
                        plugin = parts[1];
                        server = parts[2];
                    }
                }
                usages.push({ kind: "mcp_tool", name, server, plugin, trigger: "agent", tool_call_id: id, vendor: native.length <= 512 ? { tool_name: native } : undefined });
            }
            else if (native === "Skill" && isObject(raw.tool_input) && typeof raw.tool_input.skill === "string") {
                const skill = raw.tool_input.skill;
                const colon = skill.indexOf(":");
                const pluginSource = raw.command_source === "plugin";
                usages.push({ kind: "skill", name: pluginSource && colon > 0 ? skill.slice(colon + 1) : skill,
                    plugin: pluginSource && colon > 0 ? skill.slice(0, colon) : undefined,
                    vendor: colon > 0 ? { namespace: skill.slice(0, colon) } : undefined,
                    trigger: "agent", tool_call_id: id });
            }
        }
        if (input.hookName === "UserPromptExpansion" && typeof raw.command_name === "string") {
            const command = raw.command_name.replace(/^\//, "");
            if (raw.expansion_type === "mcp_prompt") {
                const parts = mcpParts(command);
                usages.push({ kind: "mcp_prompt", name: parts?.[1] ?? (command.length > 512 || /[\r\n]/.test(command) ? "Unattributed" : command), server: parts?.[0], trigger: "candidate" });
            }
            else if (raw.expansion_type === "slash_command") {
                const colon = command.indexOf(":");
                usages.push({ kind: "skill", name: raw.command_source === "plugin" && colon > 0 ? command.slice(colon + 1) : command,
                    plugin: raw.command_source === "plugin" && colon > 0 ? command.slice(0, colon) : undefined, trigger: "candidate" });
            }
        }
        return { usages };
    },
    toolKind: (name) => toolKinds[name] ?? "other",
    shellOutcome({ response, error, failed }) {
        const result = isObject(response) ? response : { stdout: response };
        let { exitCode, status } = exitOutcome(result);
        if (failed) {
            // Bash reports a nonzero exit in the first line of the failure hook's error.
            const firstLine = text(error)?.slice(0, 1024).split("\n", 1)[0] ?? "";
            const failure = /^Exit code (\d{1,15})(?:\s|$)/.exec(firstLine);
            exitCode = failure ? Number(failure[1]) : undefined;
            status = failure ? "failed" : "errored";
        }
        else if (result.interrupted === true) {
            exitCode = undefined;
            status = "errored";
        }
        else if (exitCode === undefined) {
            // A successful Bash result omits the exit code: the success hook means 0.
            exitCode = 0;
            status = "passed";
        }
        const stdout = text(result.stdout ?? result.output), stderr = text(result.stderr);
        return {
            exitCode, status, stdout, stderr,
            durationMs: typeof result.duration_ms === "number" ? result.duration_ms : undefined,
            // A failed run's output is only in the failure hook's error.
            testOutput: failed ? [text(error)] : [stdout, stderr],
        };
    },
    readUsage(input) {
        // Responses repeat across streamed records; keep the last usage per response ID,
        // in first-seen order. The Stop read window bounds this map.
        const responses = new Map();
        const effort = isObject(input.payload.effort) ? shortText(input.payload.effort.level) : undefined;
        return {
            add(record) {
                if (!isObject(record) || record.type !== "assistant" || !isObject(record.message) || !isObject(record.message.usage))
                    return;
                const model = shortText(record.message.model);
                const next = model && counters(record.message.usage, model, "cache_read_input_tokens", "cache_creation_input_tokens");
                if (!next)
                    return;
                const id = record.message.id;
                responses.set(typeof id === "string" ? id : Symbol(), next);
            },
            total() {
                let usage;
                for (const response of responses.values())
                    usage = sumUsage(usage, response);
                if (usage && effort)
                    usage.reasoning_effort = effort;
                return usage;
            },
        };
    },
    blockPrompt: (message) => ({ decision: "block", reason: message }),
};
