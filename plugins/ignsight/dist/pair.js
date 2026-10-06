import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiError, exchangeCode } from "./api.js";
import { credentialFile, refreshState } from "./capture.js";
import { deleteSecret, storeSecret } from "./keychain.js";
import { parsePairingToken } from "./pairing-token.js";
import { replaceWithLock } from "./uploader.js";
import { assertWritableDataDirectory, pairingDirectory, pairingKey, savePairing, updateState, workspaceRoot, } from "./workspace.js";
// Pairs a workspace with an attempt. Two callers share it:
// - the UserPromptSubmit hook, for `/ignsight:connect <code>` (Claude Code) or
//   `$ignsight:connect <code>` (Codex). Hooks run outside the host's sandbox,
//   so pairing works even where the model's shell cannot write the data directory.
// - `cli.js pair <code>`, the terminal path.
// Every check that can fail locally runs before the single-use code is spent.
export const hostNames = { codex: "Codex", claude_code: "Claude Code" };
// A prompt that is exactly `/ignsight:connect <token>` or `$ignsight:connect <token>`. Bounded quantifiers keep it linear-time.
const CONNECT_PROMPT = /^\s{0,64}[/$]ignsight:connect\s{1,64}(ignsight1_[A-Za-z0-9_-]{1,4096})\s{0,64}$/;
/** The pairing token of a connect prompt, or null for every other prompt. */
export function connectToken(prompt) {
    return typeof prompt === "string" ? CONNECT_PROMPT.exec(prompt)?.[1] ?? null : null;
}
/**
 * Pair `directory` using a portal pairing token. `host` is the coding agent
 * running the hook; a code minted for another producer is refused unspent.
 * Throws candidate-readable errors.
 */
export async function pairWorkspace(token, directory, host) {
    const { api, producer, code } = parsePairingToken(token);
    if (producer === "extension")
        throw new Error("This code is for the browser extension. Paste it into the extension popup instead.");
    // Exchanging another host's code would also revoke that host's working credential.
    if (host && producer !== host)
        throw new Error(`This code is for ${hostNames[producer]}, not ${hostNames[host]}. Copy the ${hostNames[host]} code from the candidate portal. The code was not used.`);
    const root = await workspaceRoot(directory);
    await assertWritableDataDirectory();
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
    const pairing = {
        version: 1, key, root, producer, api_url: api, attempt_id: exchange.attempt_id,
        credential_storage: "keychain", paired_at: new Date().toISOString(),
    };
    try {
        await mkdir(pairingDirectory(key), { recursive: true, mode: 0o700 });
        await replaceWithLock(pairing, async () => {
            // Re-pairing the same binding starts a fresh local lifecycle.
            await deleteSecret(key, credentialFile(pairing));
            await rm(resolve(pairingDirectory(key), "sessions"), { recursive: true, force: true });
            await rm(resolve(pairingDirectory(key), "state.json"), { force: true });
            pairing.credential_storage = await storeSecret(key, exchange.credential, credentialFile(pairing));
            await savePairing(pairing);
            await updateState(key, { expires_at: exchange.expires_at });
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        throw new Error(`The assessment accepted the code, but this computer could not save the pairing (${reason}). Get a new code from the candidate portal and try again.`, { cause: error });
    }
    // The first status call is what tells the portal this producer is connected.
    const state = await refreshState(pairing, 5_000).catch(() => null);
    return {
        lines: [`Paired ${hostNames[producer]} in ${root} with attempt ${pairing.attempt_id}.`, describeState(state?.state ?? null)],
        warning: pairing.credential_storage === "file"
            ? "Warning: no OS keychain was available, so the credential is stored in an owner-only file. The reviewer will see a capture warning."
            : null,
    };
}
export function describeState(state, endedAt = null) {
    switch (state) {
        case "active": return "capturing";
        case "waiting-for-start": return "waiting for the test to start";
        case "paired": return "paired";
        case "expired":
        case "ended": return `ended at ${endedAt ?? "unknown time"}`;
        default: return "unknown: the API could not be reached. Nothing is captured until it reports the attempt active.";
    }
}
