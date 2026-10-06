import { assertSafeSessionId, isObject } from "../../trace/event.js";
import { exitOutcome, text } from "../snake-case-hook.js";
/** Decode native JSON strings without treating malformed output as structured evidence. */
function decode(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value.replace(/^\uFEFF/, ""));
    }
    catch {
        return undefined;
    }
}
function directory(value) {
    return typeof value === "string" && value ? value.replace(/^\/([A-Za-z]:[\\/])/, "$1") : undefined;
}
export const cursor = {
    id: "cursor", producer: "cursor", displayName: "Cursor", connectCommand: "/connect",
    pairingInstructions: "Start a new chat now, before sending another prompt. Cursor retains blocked prompts in chat history.",
    hooks: {
        sessionStart: "SessionStart", sessionEnd: "SessionEnd", beforeSubmitPrompt: "UserPromptSubmit",
        postToolUse: "PostToolUse", postToolUseFailure: "PostToolUseFailure", preCompact: "PreCompact", stop: "Stop", afterMCPExecution: "ExtensionUsage",
    },
    parse(raw) {
        if (!isObject(raw))
            throw new Error("hook input must be an object");
        if (typeof raw.hook_event_name !== "string" || !Object.hasOwn(this.hooks, raw.hook_event_name))
            return null;
        if (typeof raw.cursor_version !== "string" && !(typeof raw.conversation_id === "string" && typeof raw.generation_id === "string") && !process.env.CURSOR_VERSION)
            return null;
        if (raw.is_background_agent === true)
            return null;
        const sessionId = text(raw.conversation_id);
        if (!sessionId)
            throw new Error("conversation_id is required");
        assertSafeSessionId(sessionId);
        const cwd = directory(raw.cwd) ?? (Array.isArray(raw.workspace_roots) ? directory(raw.workspace_roots[0]) : undefined) ?? directory(process.env.CURSOR_PROJECT_DIR);
        if (!cwd)
            throw new Error("workspace directory is required");
        const hookName = this.hooks[raw.hook_event_name];
        const payload = {};
        // Never copy identities, attachments, transcript paths, model parameters or agent summaries.
        if (hookName === "UserPromptSubmit") {
            if (typeof raw.prompt !== "string")
                throw new Error("prompt is required");
            payload.prompt = raw.prompt;
        }
        if (hookName === "SessionEnd")
            payload.reason = text(raw.reason);
        if (hookName === "PreCompact")
            payload.trigger = raw.trigger === "manual" ? "manual" : "auto";
        const completed = hookName === "PostToolUse" || hookName === "PostToolUseFailure";
        if (completed) {
            payload.tool_name = text(raw.tool_name);
            payload.tool_use_id = text(raw.tool_use_id);
            const nativeInput = decode(raw.tool_input);
            if (isObject(nativeInput)) {
                const input = { ...nativeInput };
                if (payload.tool_name === "Shell") {
                    input.workdir = directory(input.working_directory);
                    delete input.working_directory;
                }
                if (["Read", "Write", "StrReplace"].includes(String(payload.tool_name))) {
                    input.file_path = directory(input.path ?? input.file_path);
                    delete input.path;
                }
                payload.tool_input = input;
            }
            payload.tool_response = decode(raw.tool_output);
            payload.error = text(raw.error_message);
            payload.is_interrupt = raw.is_interrupt === true;
            if (Number.isSafeInteger(raw.duration) && Number(raw.duration) >= 0)
                payload.duration_ms = raw.duration;
        }
        return {
            hookName, sessionId, cwd, model: text(raw.model) ?? null, turnId: text(raw.generation_id) ?? null,
            permissionMode: null, payload, toolStartIncluded: completed,
            ...hookName === "UserPromptSubmit" && { promptOrigin: "candidate" },
        };
    },
    extension(raw, input) {
        if (input.hookName !== "ExtensionUsage" || !isObject(raw) || typeof raw.tool_name !== "string")
            return { usages: [] };
        return { usages: [{ kind: "mcp_tool", name: raw.tool_name, server: text(raw.mcp_server_name), trigger: "agent" }] };
    },
    connectToken: (prompt) => typeof prompt === "string" ? /^\s{0,64}(ignsight1_[A-Za-z0-9_-]{1,4096})\s{0,64}$/.exec(prompt)?.[1] ?? null : null,
    toolKind: (name) => name === "Shell" ? "shell" : name === "Read" ? "read" : name === "Write" ? "write" : name === "StrReplace" ? "edit" : "other",
    shellOutcome({ response, error, failed }) {
        const result = isObject(response) ? response : {};
        const outcome = failed ? { status: "errored" } : exitOutcome(result);
        const stdout = text(result.stdout), stderr = failed ? text(error) : text(result.stderr);
        return { ...outcome, stdout, stderr, testOutput: [stdout, stderr] };
    },
    blockPrompt: (message) => ({ continue: false, user_message: message }),
};
