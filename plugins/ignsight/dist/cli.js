import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { exchangeCode, ApiError } from "./api.js";
import { CaptureBuffer } from "./buffer.js";
import { credentialFile, refreshState } from "./capture.js";
import { deleteSecret, storeSecret } from "./keychain.js";
import { replaceWithLock, uploadWithLock } from "./uploader.js";
import { parsePairingToken } from "./pairing-token.js";
import { isInside, listPairings, pairingDirectory, pairingKey, readState, savePairing, updateState, workspaceRoot, } from "./workspace.js";
// `cli.js pair <pairing code> [--root <workspace>]`: pair this workspace with an attempt.
// `cli.js status [--root <workspace>] [--json]`: show the attempt, state, last upload and buffered events.
const hostNames = { codex: "Codex", claude_code: "Claude Code" };
async function main() {
    const [command, ...args] = process.argv.slice(2);
    const rootIndex = args.indexOf("--root");
    const rootOption = rootIndex === -1 ? undefined : args.splice(rootIndex, 2)[1];
    if (rootIndex !== -1 && !rootOption)
        throw new Error("--root needs a directory");
    if (command === "pair" && args.length === 1)
        await pair(args[0], resolve(rootOption ?? process.cwd()));
    else if (command === "status" && (args.length === 0 || (args.length === 1 && args[0] === "--json")))
        await status(resolve(rootOption ?? process.cwd()), args.includes("--json"));
    else
        throw new Error("Usage: cli.js pair <pairing code> [--root <workspace>] | cli.js status [--root <workspace>] [--json]");
}
async function pair(token, directory) {
    const { api, producer, code } = parsePairingToken(token);
    if (producer === "extension")
        throw new Error("This code is for the browser extension. Paste it into the extension popup instead.");
    const root = await workspaceRoot(directory);
    let exchange;
    try {
        exchange = await exchangeCode(api, producer, code);
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 401)
            throw new Error("The pairing code was rejected: it expired, was already used, or the assessment has ended. Get a new code from the candidate portal.", { cause: error });
        throw new Error(`Could not reach the assessment API at ${api}.`, { cause: error });
    }
    if (!exchange.attempt_id)
        throw new Error("The API returned a credential without an attempt.");
    const key = pairingKey(producer, root, exchange.attempt_id);
    await mkdir(pairingDirectory(key), { recursive: true, mode: 0o700 });
    const pairing = {
        version: 1, key, root, producer, api_url: api, attempt_id: exchange.attempt_id,
        credential_storage: "keychain", paired_at: new Date().toISOString(),
    };
    await replaceWithLock(pairing, async () => {
        // Re-pairing the same binding starts a fresh local lifecycle.
        await deleteSecret(key, credentialFile(pairing));
        await rm(resolve(pairingDirectory(key), "sessions"), { recursive: true, force: true });
        await rm(resolve(pairingDirectory(key), "state.json"), { force: true });
        pairing.credential_storage = await storeSecret(key, exchange.credential, credentialFile(pairing));
        await savePairing(pairing);
        await updateState(key, { expires_at: exchange.expires_at });
    });
    const state = await refreshState(pairing).catch(() => null);
    console.log(`Paired ${hostNames[producer]} in ${root} with attempt ${pairing.attempt_id}.`);
    console.log(describeState(state?.state ?? null));
    if (pairing.credential_storage === "file") {
        console.error("Warning: no OS keychain was available, so the credential is stored in an owner-only file. The reviewer will see a capture warning.");
    }
}
async function status(directory, json) {
    const pairings = (await listPairings()).filter((pairing) => isInside(directory, pairing.root) || isInside(pairing.root, directory));
    if (!pairings.length) {
        if (json) {
            console.log("[]");
            return;
        }
        console.log(`Not paired: ${directory}\nRun /ignsight:connect with a pairing code from the candidate portal in your assignment workspace.`);
        return;
    }
    const reports = [];
    for (const pairing of pairings.sort((a, b) => b.paired_at.localeCompare(a.paired_at))) {
        let state = await refreshState(pairing).catch(() => readState(pairing.key));
        if (state.state === "expired" || (state.state !== "ended" && state.expires_at && Date.parse(state.expires_at) <= Date.now())) {
            await uploadWithLock(pairing);
            state = await readState(pairing.key);
        }
        const storage = pairing.credential_storage === "file" ? "file fallback warning: credential stored in an owner-only file" : "keychain";
        const report = {
            producer: pairing.producer, workspace_root: pairing.root, attempt_id: pairing.attempt_id,
            state: describeState(state.state, state.ended_at ?? state.expires_at), valid_until: state.expires_at,
            last_successful_upload: state.last_upload_at,
            buffered_count: await new CaptureBuffer(pairingDirectory(pairing.key)).bufferedCount(),
            credential_storage: state.state === "ended" ? `removed (${storage})` : storage,
            last_error: state.last_error, end_reason: state.end_reason,
            uploaded_events: state.uploaded_events, dropped_events: state.dropped_events,
        };
        reports.push(report);
        if (!json)
            console.log([
                `Producer: ${hostNames[pairing.producer]}`,
                `  Workspace root: ${report.workspace_root}`,
                `  Attempt: ${report.attempt_id}`,
                `  State: ${report.state}`,
                `  Valid until: ${report.valid_until ?? "unknown"}`,
                `  Last upload: ${report.last_successful_upload ?? "never"}`,
                `  Buffered events: ${report.buffered_count}`,
                `  Credential storage: ${report.credential_storage}`,
                `  Last error: ${report.last_error ?? "none"}`,
                ...state.state === "ended" ? [`  End reason: ${state.end_reason}`, `  Uploaded events: ${state.uploaded_events}`, `  Dropped events: ${state.dropped_events}`] : [],
            ].join("\n"));
    }
    if (json)
        console.log(JSON.stringify(reports, null, 2));
}
function describeState(state, endedAt = null) {
    switch (state) {
        case "active": return "capturing";
        case "waiting-for-start": return "waiting for the test to start";
        case "paired": return "paired";
        case "expired":
        case "ended": return `ended at ${endedAt ?? "unknown time"}`;
        default: return "unknown: the API could not be reached. Nothing is captured until it reports the attempt active.";
    }
}
try {
    await main();
}
catch (error) {
    console.error(error instanceof Error ? error.message : "capture CLI failed");
    process.exitCode = 1;
}
