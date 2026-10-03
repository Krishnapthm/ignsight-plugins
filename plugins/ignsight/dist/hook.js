import { realpath } from "node:fs/promises";
import { parseHookInput as parseClaude } from "./claude-code/parse-hook.js";
import { parseHookInput as parseCodex } from "./codex/parse-hook.js";
import { CaptureBuffer } from "./buffer.js";
import { captureState } from "./capture.js";
import { hookEvents } from "./trace/canonical.js";
import { hostProducer } from "./trace/event.js";
import { redact } from "./trace/redact.js";
import { readUsage, transcriptBoundary } from "./trace/usage.js";
import { OUT_OF_WORKSPACE, scopePayload } from "./trace/scope.js";
import { spawnUploader } from "./uploader.js";
import { findPairing, pairingDirectory } from "./workspace.js";
// Hook entrypoint: `node dist/hook.js <codex|claude-code>` with the hook JSON on stdin.
// Captures only inside a paired workspace while the API reports the attempt active,
// buffers canonical events locally, and hands upload to a detached process.
// Bounds the status check made while capture is not active, inside the 3s hook budget.
const STATUS_TIMEOUT_MS = 1_200;
const fileFallbackWarning = {
    event_type: "capture.warning", actor: "system",
    payload: { code: "credential_file_fallback", message: "No OS keychain was available, so the capture credential is stored in an owner-only file." },
};
try {
    let text = "";
    for await (const chunk of process.stdin)
        text += String(chunk);
    const raw = JSON.parse(text);
    const host = process.argv[2];
    if (host !== "codex" && host !== "claude-code")
        throw new Error("unknown host");
    const input = host === "codex" ? parseCodex(raw) : parseClaude(raw);
    const cwd = await realpath(input.cwd || process.cwd());
    const pairing = await findPairing(cwd, hostProducer[host]);
    // Fail closed: no pairing, or any state but active (before the slot opens, after it ends, or unknown).
    if (pairing && await captureState(pairing, STATUS_TIMEOUT_MS) === "active") {
        const payload = await scopePayload(input.payload, cwd, pairing.root);
        const session = {
            client_session_id: input.sessionId, source: host, source_kind: "coding_agent", ...input.model && { model_name: input.model.slice(0, 255) },
        };
        const opening = pairing.credential_storage === "file" ? [fileFallbackWarning] : [];
        const buffer = new CaptureBuffer(pairingDirectory(pairing.key));
        // Keep transcript and tool bookkeeping in the same locked metadata transaction as the events.
        await buffer.append(session, async (record) => {
            if (input.hookName === "UserPromptSubmit" && !record.transcript)
                record.transcript = await transcriptBoundary(input.transcriptPath);
            const usage = input.hookName === "Stop" ? await readUsage(input, record.transcript) : {};
            if (usage.cursor)
                record.transcript = usage.cursor;
            if (usage.usage)
                record.session.model_name = usage.usage.model;
            const rawId = payload.tool_use_id ?? payload.call_id;
            const id = typeof rawId === "string" ? rawId.slice(0, 255) : undefined;
            const pending = record.pending_tests ?? [];
            const testStart = pending.find((test) => test.id === id);
            const drafts = await hookEvents({ ...input, payload }, pairing.root, cwd, { usage: usage.usage, testStart });
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
            // The redacted host payload rides along as raw, unless scoping withheld content.
            const rawPayload = redact(payload);
            return JSON.stringify(payload).includes(OUT_OF_WORKSPACE)
                ? drafts
                : drafts.map((draft) => ({ ...draft, raw: { source_type: input.hookName, payload: rawPayload } }));
        }, opening);
        // A full buffer still needs retrying on later hooks after an offline uploader exits.
        if (await buffer.bufferedCount())
            await spawnUploader(pairing);
    }
}
catch { /* Observation must never interrupt the candidate or inject stdout into context. */ }
process.exitCode = 0;
