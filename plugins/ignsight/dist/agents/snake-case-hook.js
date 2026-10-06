import { assertSafeSessionId, isObject } from "../trace/event.js";
// Claude Code and Codex send the same snake_case hook payload shape
// (`hook_event_name`, `session_id`, `cwd`, `tool_use_id`, ...), so their
// adapters share this parser. An agent with another shape writes its own.
// The payload fields both agents send under the shared names. Everything
// else (identities, agent internals, compaction summaries) is dropped.
const payloadFields = [
    "prompt", "source", "reason", "trigger", "last_assistant_message", "stop_hook_active",
    "error", "is_interrupt", "tool_name", "tool_use_id", "tool_input", "tool_response", "duration_ms", "effort",
];
/**
 * Parse one snake_case hook. A `hook_event_name` this agent does not register
 * means another agent is running the hook (some agents import other agents'
 * plugins), so the payload is declined with null. `promptOrigin` is the
 * adapter's reading of who started a UserPromptSubmit prompt.
 */
export function parseSnakeCaseHook(input, hooks, promptOrigin, additionalFields = []) {
    if (!isObject(input))
        throw new Error("hook input must be a JSON object");
    const native = input.hook_event_name;
    if (typeof native !== "string")
        throw new Error("hook input requires hook_event_name");
    if (!Object.hasOwn(hooks, native))
        return null;
    const hookName = hooks[native];
    if (typeof input.session_id !== "string")
        throw new Error("hook input requires session_id");
    assertSafeSessionId(input.session_id);
    // Both adapters using this helper run hooks in the project directory.
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (hookName === "UserPromptSubmit" && typeof input.prompt !== "string")
        throw new Error("UserPromptSubmit requires a string prompt");
    const payload = {};
    for (const field of [...payloadFields, ...additionalFields])
        if (input[field] !== undefined)
            payload[field] = input[field];
    // Older Codex builds name the tool call ID `call_id`.
    if (payload.tool_use_id === undefined && input.call_id !== undefined)
        payload.tool_use_id = input.call_id;
    return {
        hookName, sessionId: input.session_id,
        ...hookName === "UserPromptSubmit" && { promptOrigin: promptOrigin(String(input.prompt)) },
        turnId: typeof input.turn_id === "string" ? input.turn_id : null,
        transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
        model: typeof input.model === "string" ? input.model : null,
        cwd,
        permissionMode: typeof input.permission_mode === "string" ? input.permission_mode : null,
        payload,
    };
}
/** The identity map for agents whose native hook names are the lifecycle names. */
export function sameNames(names) {
    return Object.fromEntries(names.map((name) => [name, name]));
}
/** Exit code and status from `exit_code`/`exitCode`; without one the result is errored. */
export function exitOutcome(result) {
    const exitCode = result.exit_code ?? result.exitCode;
    const code = Number.isSafeInteger(exitCode) ? exitCode : undefined;
    return { exitCode: code, status: code === undefined ? "errored" : code === 0 ? "passed" : "failed" };
}
export function text(value) {
    return typeof value === "string" ? value : undefined;
}
