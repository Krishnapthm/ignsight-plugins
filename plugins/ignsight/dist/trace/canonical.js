import { relative, resolve, sep } from "node:path";
import { isInside } from "../workspace.js";
import { isObject } from "./event.js";
import { isSensitiveName, REDACTED, redactString, TRUNCATED_SUFFIX } from "./redact.js";
import { isPatch, OUT_OF_WORKSPACE, resolveReal, SENSITIVE_FILE } from "./scope.js";
// Host tool names that run a shell command, read a file, or change files.
const shellTools = new Set(["Bash", "shell", "exec_command", "local_shell"]);
const readTools = new Set(["Read"]);
const writeTools = new Set(["Write"]);
const editTools = new Set(["Edit", "MultiEdit"]);
const patchTools = new Set(["apply_patch"]);
/** Canonical events for a scoped hook. Hooks without a source-neutral meaning yield none. */
export async function hookEvents(input, root, cwd) {
    const context = { input, root, cwd };
    const p = input.payload;
    const vendor = vendorDetail(input);
    let drafts;
    switch (input.hookName) {
        case "SessionStart":
            drafts = [{ event_type: "session.started", actor: "system", payload: { reason: text(p.source), model: input.model ?? undefined, vendor } }];
            break;
        case "SessionEnd":
            drafts = [{ event_type: "session.ended", actor: "system", payload: { reason: text(p.reason), vendor } }];
            break;
        case "UserPromptSubmit":
            drafts = [{ event_type: "message.candidate", actor: "candidate", payload: { text: String(p.prompt), vendor } }];
            break;
        case "Stop":
            drafts = typeof p.last_assistant_message === "string"
                ? [{ event_type: "message.agent", actor: "agent", payload: { text: p.last_assistant_message, vendor } }]
                : [];
            break;
        case "StopFailure":
            drafts = [{ event_type: "capture.warning", actor: "system", payload: { code: "turn_failed", message: text(p.error) ?? "The agent turn failed", vendor } }];
            break;
        case "PreCompact":
        case "PostCompact":
            drafts = [{
                    event_type: p.trigger === "manual" ? "context.compaction.user" : "context.compaction.auto",
                    actor: "system", payload: { phase: input.hookName === "PreCompact" ? "started" : "completed", vendor },
                }];
            break;
        case "PreToolUse":
            drafts = await toolStart(context);
            break;
        case "PostToolUse":
        case "PostToolUseFailure":
            drafts = await toolEnd(context, input.hookName === "PostToolUseFailure");
            break;
        default:
            drafts = [];
    }
    return drafts.map(finalize);
}
async function toolStart({ input, root, cwd }) {
    const p = input.payload;
    const name = toolName(p);
    const id = toolCallId(p);
    const toolInput = isObject(p.tool_input) ? p.tool_input : {};
    const vendor = vendorDetail(input, name);
    if (shellTools.has(name)) {
        const workdir = typeof toolInput.workdir === "string" ? resolve(cwd, toolInput.workdir) : cwd;
        return [{ event_type: "shell.command", actor: "agent", payload: { command: commandText(toolInput.command ?? toolInput.cmd), cwd: await workspacePath(root, cwd, workdir), tool_call_id: id, vendor } }];
    }
    if (readTools.has(name)) {
        return [{ event_type: "file.read", actor: "agent", payload: { path: await workspacePath(root, cwd, toolInput.file_path), tool_call_id: id, vendor } }];
    }
    // File changes are recorded from the result, which says what actually changed.
    if (writeTools.has(name) || editTools.has(name) || patchTools.has(name))
        return [];
    return [{ event_type: "tool.call", actor: "agent", payload: { tool_call_id: id, tool_name: name, input: toolInputObject(p.tool_input), vendor } }];
}
async function toolEnd({ input, root, cwd }, failed) {
    const p = input.payload;
    const name = toolName(p);
    const id = toolCallId(p);
    const toolInput = isObject(p.tool_input) ? p.tool_input : {};
    const response = p.tool_response;
    const vendor = vendorDetail(input, name);
    if (!failed && shellTools.has(name)) {
        const result = isObject(response) ? response : { stdout: response };
        const exitCode = result.exit_code ?? result.exitCode;
        return [{ event_type: "shell.result", actor: "tool", payload: {
                    tool_call_id: id,
                    exit_code: Number.isSafeInteger(exitCode) ? exitCode : undefined,
                    stdout: text(result.stdout ?? result.output), stderr: text(result.stderr), vendor,
                } }];
    }
    if (!failed && readTools.has(name))
        return []; // The read was recorded from PreToolUse; its content is the repository file.
    if (!failed && writeTools.has(name)) {
        const created = isObject(response) && response.type === "create";
        return [{ event_type: "file.write", actor: "agent", payload: { path: await workspacePath(root, cwd, toolInput.file_path), change_type: created ? "created" : "modified", tool_call_id: id, vendor } }];
    }
    if (!failed && editTools.has(name)) {
        const patch = structuredPatch(isObject(response) ? response.structuredPatch : undefined);
        return [{ event_type: "file.patch", actor: "agent", payload: {
                    path: await workspacePath(root, cwd, toolInput.file_path), change_type: "modified",
                    ...patch && { patch: patch.text, additions: patch.additions, deletions: patch.deletions }, tool_call_id: id, vendor,
                } }];
    }
    if (!failed && patchTools.has(name)) {
        const patch = typeof p.tool_input === "string" ? p.tool_input : Object.values(toolInput).find((value) => typeof value === "string" && (isPatch(value) || value === OUT_OF_WORKSPACE || value === SENSITIVE_FILE));
        // A scoped-out patch keeps only its marker: neither its paths nor its content are recorded.
        if (typeof patch !== "string" || !isPatch(patch)) {
            return [{ event_type: "file.patch", actor: "agent", payload: { path: typeof patch === "string" ? patch : undefined, patch: typeof patch === "string" ? patch : undefined, tool_call_id: id, vendor } }];
        }
        return Promise.all(patchSections(patch).map(async (section) => ({ event_type: "file.patch", actor: "agent", payload: {
                path: await workspacePath(root, cwd, section.path), change_type: section.change,
                patch: section.text, additions: section.additions, deletions: section.deletions, tool_call_id: id, vendor,
            } })));
    }
    return [{ event_type: "tool.result", actor: "tool", payload: {
                tool_call_id: id, tool_name: name, status: failed ? "failed" : "succeeded", output: response ?? p.error, vendor,
            } }];
}
/** Redact every string, turn scope markers into omissions, and attach the contract's redaction markers. */
function finalize(draft) {
    const markers = [];
    const payload = clean(draft.payload, "", false, markers);
    if (markers.length)
        payload.redactions = markers;
    return { ...draft, payload };
}
const OMIT = Symbol("omit");
function clean(value, pointer, sensitive, markers) {
    if (typeof value === "string") {
        if (value === OUT_OF_WORKSPACE) {
            markers.push({ kind: "out_of_workspace", pointer });
            return OMIT;
        }
        if (value === SENSITIVE_FILE) {
            markers.push({ kind: "sensitive_file", pointer });
            return OMIT;
        }
        const result = sensitive ? REDACTED : redactString(value);
        const count = occurrences(result, REDACTED) - occurrences(value, REDACTED);
        if (count > 0)
            markers.push({ kind: "secret_redacted", pointer, count });
        if (result !== value && result.endsWith(TRUNCATED_SUFFIX))
            markers.push({ kind: "truncated", pointer });
        return result;
    }
    // Omitted array items become null so later pointers keep their index.
    if (Array.isArray(value))
        return value.map((item, index) => { const next = clean(item, `${pointer}/${index}`, sensitive, markers); return next === OMIT ? null : next; });
    if (isObject(value)) {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            const next = clean(item, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, sensitive || isSensitiveName(key), markers);
            if (next !== OMIT)
                output[key] = next;
        }
        return output;
    }
    return value;
}
function occurrences(text, part) {
    return text.split(part).length - 1;
}
/** A `/`-separated path relative to the root, or the out-of-workspace marker. */
async function workspacePath(root, cwd, path) {
    if (typeof path !== "string" || !path)
        return undefined;
    const real = await resolveReal(resolve(cwd, path));
    if (!isInside(real, root))
        return OUT_OF_WORKSPACE;
    return relative(root, real).split(sep).join("/") || ".";
}
function vendorDetail(input, toolName) {
    const vendor = Object.fromEntries(Object.entries({ turn_id: input.turnId, permission_mode: input.permissionMode, tool_name: toolName })
        .filter(([, value]) => value != null));
    return Object.keys(vendor).length ? vendor : undefined;
}
function toolName(payload) {
    return typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name.slice(0, 255) : "unknown";
}
function toolCallId(payload) {
    const id = payload.tool_use_id ?? payload.call_id;
    return typeof id === "string" && id ? id.slice(0, 255) : "unknown";
}
function toolInputObject(value) {
    if (value === undefined)
        return undefined;
    return isObject(value) ? value : { value };
}
function commandText(command) {
    if (Array.isArray(command))
        return command.map(String).join(" ");
    return typeof command === "string" ? command : "";
}
function text(value) {
    return typeof value === "string" ? value : undefined;
}
// Claude Code reports Edit results as structured hunks; render them as a unified diff.
function structuredPatch(value) {
    if (!Array.isArray(value) || !value.length)
        return null;
    const hunks = value.filter((hunk) => isObject(hunk) && Array.isArray(hunk.lines));
    const lines = hunks.flatMap((hunk) => hunk.lines.map(String));
    return {
        text: hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`).join("\n"),
        additions: lines.filter((line) => line.startsWith("+")).length,
        deletions: lines.filter((line) => line.startsWith("-")).length,
    };
}
// Codex apply_patch: one `*** Add|Update|Delete File:` section per file.
function patchSections(patch) {
    const sections = [];
    const changes = { Add: "created", Update: "modified", Delete: "deleted" };
    for (const line of patch.split("\n")) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
        const move = /^\*\*\* Move to: (.+)$/.exec(line);
        if (header)
            sections.push({ path: header[2].trim(), change: changes[header[1]], lines: [line] });
        else if (move && sections.length) {
            sections.at(-1).path = move[1].trim();
            sections.at(-1).lines.push(line);
        }
        else if (line !== "*** Begin Patch" && line !== "*** End Patch")
            sections.at(-1)?.lines.push(line);
    }
    return sections.map(({ lines, ...section }) => ({
        ...section, text: lines.join("\n"),
        additions: lines.filter((line) => line.startsWith("+")).length,
        deletions: lines.filter((line) => line.startsWith("-")).length,
    }));
}
