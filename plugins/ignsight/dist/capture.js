import { join } from "node:path";
import { ApiError, producerStatus } from "./api.js";
import { spawnUploader } from "./uploader.js";
import { readSecret } from "./keychain.js";
import { pairingDirectory, readState, updateState } from "./workspace.js";
// Server-backed capture authorization. Capture fails closed: without a readable
// credential, or once the API says the credential expired or is unknown, nothing
// is captured. The uploader may drain pre-end evidence during the upload grace.
// A cached `active` is trusted this long; the uploader corrects it sooner on 401/409.
const ACTIVE_TTL_MS = 10 * 60_000;
export function credentialFile(pairing) {
    return join(pairingDirectory(pairing.key), "credential");
}
export async function credentialFor(pairing) {
    return readSecret(pairing.key, pairing.credential_storage, credentialFile(pairing));
}
/** Ask the API for the credential's state and cache it. Unknown credentials (401) are expired. */
export async function refreshState(pairing, timeoutMs = 10_000) {
    const cached = await readState(pairing.key);
    if (cached.state === "ended")
        return cached;
    const credential = await credentialFor(pairing);
    if (!credential)
        return updateState(pairing.key, { state: "expired", checked_at: new Date().toISOString(), last_error: "The credential is missing from the keychain. Pair again." });
    try {
        const status = await producerStatus(pairing.api_url, pairing.producer, credential, timeoutMs);
        return updateState(pairing.key, { state: status.state, checked_at: new Date().toISOString(), expires_at: status.expires_at });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            return updateState(pairing.key, { state: "expired", checked_at: new Date().toISOString(), last_error: "The API no longer recognizes this pairing. Pair again." });
        }
        throw error;
    }
}
/**
 * The state a hook acts on. A fresh cached `active` needs no network call, so
 * capture adds no latency during the attempt; any other state is re-checked
 * (bounded by `timeoutMs`) so the first prompt after the attempt starts is kept.
 */
export async function captureState(pairing, timeoutMs, now = Date.now()) {
    const cached = await readState(pairing.key);
    if (cached.state === "ended")
        return "expired";
    if (cached.state === "expired" || (cached.expires_at && Date.parse(cached.expires_at) <= now)) {
        await updateState(pairing.key, { state: "expired" });
        spawnUploader(pairing);
        return "expired";
    }
    if (cached.state === "active" && cached.checked_at && now - Date.parse(cached.checked_at) < ACTIVE_TTL_MS)
        return "active";
    try {
        const state = (await refreshState(pairing, timeoutMs)).state;
        if (state === "expired")
            spawnUploader(pairing);
        return state === "ended" ? "expired" : state;
    }
    catch {
        return cached.state === "active" ? "active" : null;
    } // Offline during an attempt: keep buffering.
}
