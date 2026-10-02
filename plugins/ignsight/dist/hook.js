import { realpath } from "node:fs/promises";
import { parseHookInput as parseClaude } from "./claude-code/parse-hook.js";
import { parseHookInput as parseCodex } from "./codex/parse-hook.js";
import { CaptureBuffer } from "./buffer.js";
import { captureState } from "./capture.js";
import { hookEvents } from "./trace/canonical.js";
import { hostProducer } from "./trace/event.js";
import { redact } from "./trace/redact.js";
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
        const drafts = await hookEvents({ ...input, payload }, pairing.root, cwd);
        // The redacted host payload rides along as `raw`, unless scoping withheld a path or content.
        const rawPayload = redact(payload);
        const withRaw = JSON.stringify(payload).includes(OUT_OF_WORKSPACE)
            ? drafts
            : drafts.map((draft) => ({ ...draft, raw: { source_type: input.hookName, payload: rawPayload } }));
        const session = {
            client_session_id: input.sessionId, source: host, source_kind: "coding_agent", ...input.model && { model_name: input.model.slice(0, 255) },
        };
        const opening = pairing.credential_storage === "file" ? [fileFallbackWarning] : [];
        const appended = await new CaptureBuffer(pairingDirectory(pairing.key)).append(session, withRaw, opening);
        if (appended.length)
            spawnUploader(pairing);
    }
}
catch { /* Observation must never interrupt the candidate or inject stdout into context. */ }
process.exitCode = 0;
