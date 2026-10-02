import { assertSafeSessionId, isObject } from "./event.js";
// Envelope fields every hook carries. `transcript_path` is dropped: native transcripts are never read.
const commonFields = new Set(["session_id", "turn_id", "cwd", "model", "hook_event_name", "transcript_path", "permission_mode"]);
export function parseHook(input, source, hooks) {
    if (!isObject(input))
        throw new Error("hook input must be a JSON object");
    const hookName = input.hook_event_name;
    if (typeof hookName !== "string" || !hooks.has(hookName))
        throw new Error("unsupported hook event");
    if (typeof input.session_id !== "string")
        throw new Error("hook input requires session_id");
    assertSafeSessionId(input.session_id);
    if (hookName === "UserPromptSubmit" && typeof input.prompt !== "string")
        throw new Error("UserPromptSubmit requires a string prompt");
    return {
        source, hookName, sessionId: input.session_id,
        turnId: typeof input.turn_id === "string" ? input.turn_id : null,
        model: typeof input.model === "string" ? input.model : null,
        cwd: typeof input.cwd === "string" ? input.cwd : null,
        permissionMode: typeof input.permission_mode === "string" ? input.permission_mode : null,
        payload: Object.fromEntries(Object.entries(input).filter(([key]) => !commonFields.has(key))),
    };
}
