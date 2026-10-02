import { parseHook } from "../trace/parse-hook.js";
/** Claude Code hooks the plugin registers (plugin/hooks/claude-code.json). */
export const hookNames = new Set([
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "Stop", "StopFailure", "PreCompact", "PostCompact",
]);
export function parseHookInput(input) {
    return parseHook(input, "claude-code", hookNames);
}
