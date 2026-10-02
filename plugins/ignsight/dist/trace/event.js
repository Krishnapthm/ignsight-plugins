/** The credential producer for each host. The host name is also the evidence `source`. */
export const hostProducer = { codex: "codex", "claude-code": "claude_code" };
export function assertSafeSessionId(sessionId) {
    if (!sessionId || sessionId.length > 255 || sessionId === "." || sessionId === ".." || /[/\\\0]/.test(sessionId)) {
        throw new Error("hook input requires a safe non-empty session_id");
    }
}
export function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
