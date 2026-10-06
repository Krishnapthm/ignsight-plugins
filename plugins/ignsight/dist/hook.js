import { realpath } from "node:fs/promises";
import { agentById, agents } from "./agents/index.js";
import { CaptureBuffer } from "./buffer.js";
import { captureState } from "./capture.js";
import { connectToken, pairWorkspace } from "./pair.js";
import { hookEvents } from "./trace/canonical.js";
import { redact } from "./trace/redact.js";
import { readUsage, transcriptBoundary } from "./trace/usage.js";
import { OUT_OF_WORKSPACE, scopePayload } from "./trace/scope.js";
import { spawnUploader } from "./uploader.js";
import { findPairing, pairingDirectory } from "./workspace.js";
// Hook entrypoint: `node dist/hook.js <agent id>` with the agent's hook JSON on
// stdin; src/agents/index.ts maps the id to its adapter. A connect prompt pairs
// the workspace and is blocked with the result. Otherwise it captures only
// inside a paired workspace while the API reports the attempt active, buffers
// canonical events locally, and hands upload to a detached process.
//
// Every path exits 0. The only stdout is the adapter's prompt-block object for
// a connect prompt, serialized here, so no other path can inject text into the
// agent's context or turn a hook into a block.
// Bounds the status check made while capture is not active, inside the 3s capture hook budget.
const STATUS_TIMEOUT_MS = 1_200;
const fileFallbackWarning = {
    event_type: "capture.warning", actor: "system",
    payload: { code: "credential_file_fallback", message: "No OS keychain was available, so the capture credential is stored in an owner-only file." },
};
const connectCommands = agents.map((agent) => agent.connectCommand);
/** Handle one parsed hook. Returns the prompt-block object for a connect prompt, otherwise null. */
async function handle(agent, input, raw) {
    const cwd = await realpath(input.cwd);
    // Only a prompt the candidate submitted can pair; an agent-started turn never spends a code.
    const token = input.promptOrigin === "candidate" ? (connectToken(input.payload.prompt, connectCommands) ?? agent.connectToken?.(input.payload.prompt)) : null;
    if (token) {
        // Pair here, outside the agent's sandbox, and block the prompt: the candidate
        // sees the result and the pairing code never reaches the model.
        let reason;
        try {
            const { lines, warning } = await pairWorkspace(token, cwd, agent.producer);
            reason = [...lines, ...warning ? [warning] : []].join("\n");
        }
        catch (error) {
            reason = `Ignsight pairing failed: ${error instanceof Error ? error.message : "unknown error"}`;
        }
        return agent.blockPrompt([reason, ...agent.pairingInstructions ? [agent.pairingInstructions] : []].join("\n"));
    }
    const pairing = await findPairing(cwd, agent.producer);
    // Fail closed: no pairing, or any state but active (before the slot opens, after it ends, or unknown).
    if (!pairing || await captureState(pairing, STATUS_TIMEOUT_MS) !== "active")
        return null;
    const attribution = await agent.extension?.(raw, { ...input, cwd }, pairing.root);
    if (attribution) {
        input.extensions = attribution.usages;
        input.withholdToolContent = attribution.withholdToolContent;
    }
    const payload = await scopePayload(input.payload, cwd, pairing.root, input.withholdToolContent);
    const session = {
        client_session_id: input.sessionId, source: agent.id, source_kind: "coding_agent", ...input.model && { model_name: input.model.slice(0, 255) },
    };
    const opening = pairing.credential_storage === "file" ? [fileFallbackWarning] : [];
    const buffer = new CaptureBuffer(pairingDirectory(pairing.key));
    // Keep transcript and tool bookkeeping in the same locked metadata transaction as the events.
    await buffer.append(session, async (record) => {
        // Agent-started prompts set the boundary too, on purpose, so usage of those turns is still counted.
        if (input.hookName === "UserPromptSubmit" && !record.transcript)
            record.transcript = await transcriptBoundary(input.transcriptPath);
        const usage = input.hookName === "Stop" && agent.readUsage ? await readUsage(input, agent.readUsage(input), record.transcript) : {};
        if (usage.cursor)
            record.transcript = usage.cursor;
        if (usage.usage)
            record.session.model_name = usage.usage.model;
        const id = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 255) : undefined;
        const pending = record.pending_tests ?? [];
        const testStart = pending.find((test) => test.id === id);
        const drafts = await hookEvents({ ...input, payload }, agent, pairing.root, cwd, { usage: usage.usage, testStart });
        if (usage.limited)
            drafts.push({ event_type: "capture.warning", actor: "system", payload: { code: "usage_read_limit", message: "Transcript usage exceeded the bounded read limit; usage was omitted." } });
        for (const draft of drafts) {
            if (draft.event_type === "test.run" && draft.payload.tool_call_id && draft.payload.tool_call_id !== "unknown") {
                record.pending_tests = [...pending.filter((test) => test.id !== draft.payload.tool_call_id), { id: draft.payload.tool_call_id, runner: draft.payload.runner, started_at: Date.now() }].slice(-128);
            }
        }
        if (input.hookName === "PostToolUse" || input.hookName === "PostToolUseFailure")
            record.pending_tests = pending.filter((test) => test.id !== id);
        if (input.hookName === "SessionEnd")
            record.pending_tests = [];
        // The redacted, allowlisted payload rides along as raw, unless scoping withheld
        // content or the prompt was agent-started (its text is agent content, never evidence).
        const rawPayload = redact(payload);
        return input.promptOrigin === "host" || JSON.stringify(payload).includes(OUT_OF_WORKSPACE)
            ? drafts
            : drafts.map((draft) => draft.event_type === "extension.used" ? draft : ({ ...draft, raw: { source_type: input.hookName, payload: rawPayload } }));
    }, opening);
    // A full buffer still needs retrying on later hooks after an offline uploader exits.
    if (await buffer.bufferedCount())
        await spawnUploader(pairing);
    return null;
}
let block = null;
try {
    let text = "";
    for await (const chunk of process.stdin)
        text += String(chunk);
    const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
    const agent = agentById(process.argv[2]);
    if (!agent)
        throw new Error("unknown coding agent");
    // null: another agent's payload reached this adapter's hook, so it is not ours to capture.
    const input = agent.parse(raw);
    if (input) {
        block = await handle(agent, input, raw);
    }
}
catch { /* Observation must never interrupt the candidate; failures are silent and fail open. */ }
if (block)
    process.stdout.write(`${JSON.stringify(block)}\n`);
process.exitCode = 0;
