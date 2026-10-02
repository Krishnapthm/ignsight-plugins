import { parseHook } from "../trace/parse-hook.js";
/** Codex hooks the plugin registers (plugin/hooks/codex.json). */
export const hookNames = new Set([
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact", "PostCompact",
]);
export function parseHookInput(input) {
    return parseHook(input, "codex", hookNames);
}
