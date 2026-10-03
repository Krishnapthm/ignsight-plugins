import { spawn } from "node:child_process";
import { open, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApiError, uploadBatch } from "./api.js";
import { CaptureBuffer, MAX_BATCH_EVENTS, MAX_BATCH_BYTES } from "./buffer.js";
import { withFileLock } from "./file-lock.js";
import { credentialFile, credentialFor, refreshState } from "./capture.js";
import { deleteSecret } from "./keychain.js";
import { PRODUCER } from "./version.js";
import { pairingDirectory, readState, updateState } from "./workspace.js";
const UPLOAD_GRACE_MS = 120_000;
/** Drain through upload grace at expiry, then retain only pairing and status metadata. */
export async function flushPairing(pairing, options = {}) {
    const now = options.now ?? Date.now;
    let state = await readState(pairing.key);
    if (state.state === "ended") {
        if ((await new CaptureBuffer(pairingDirectory(pairing.key)).sessionIds()).length)
            await endPairing(pairing, state.end_reason ?? "The assessment credential expired.", now());
        return "stopped";
    }
    if (state.expires_at && Date.parse(state.expires_at) <= now()) {
        state = await updateState(pairing.key, { state: "expired" });
    }
    else if (state.state !== "expired") {
        state = await refreshState(pairing).catch(() => state);
    }
    let result = "gave-up";
    try {
        if (state.state !== "expired" || (state.expires_at && now() < Date.parse(state.expires_at) + UPLOAD_GRACE_MS)) {
            result = await drainPairing(pairing, options);
        }
        else {
            result = "stopped";
        }
        return result;
    }
    finally {
        const latest = await readState(pairing.key);
        const expired = latest.state === "expired" || (latest.expires_at !== null && Date.parse(latest.expires_at) <= now());
        const graceEnded = latest.expires_at !== null && now() >= Date.parse(latest.expires_at) + UPLOAD_GRACE_MS;
        if (expired && (result === "stopped" || graceEnded || !await new CaptureBuffer(pairingDirectory(pairing.key)).bufferedCount())) {
            await endPairing(pairing, latest.last_error ?? "The assessment credential expired.", now());
        }
    }
}
export async function endPairing(pairing, reason, now = Date.now()) {
    const buffer = new CaptureBuffer(pairingDirectory(pairing.key));
    await buffer.withLock(async () => {
        const state = await readState(pairing.key);
        let uploaded = 0;
        let rejected = 0;
        for (const id of await buffer.sessionIds()) {
            const record = await buffer.record(id);
            if (record) {
                uploaded += record.acknowledged - record.rejected;
                rejected += record.rejected;
            }
        }
        const dropped = rejected + await buffer.bufferedCount();
        try {
            await deleteSecret(pairing.key, credentialFile(pairing));
        }
        catch (error) {
            await updateState(pairing.key, { last_error: error instanceof Error ? error.message : "Could not remove the capture credential." });
            throw error;
        }
        await updateState(pairing.key, {
            last_error: state.last_error?.includes("events stay buffered") ? "Upload failed after retries; remaining events were dropped at assessment end." : state.last_error,
            state: "ended",
            ended_at: state.ended_at ?? (state.expires_at && Date.parse(state.expires_at) <= now ? state.expires_at : new Date(now).toISOString()),
            end_reason: reason,
            uploaded_events: state.state === "ended" ? state.uploaded_events : uploaded,
            dropped_events: state.state === "ended" ? state.dropped_events : dropped,
        });
        await rm(join(pairingDirectory(pairing.key), "sessions"), { recursive: true, force: true });
    });
}
/** Upload every buffered session of a pairing. */
async function drainPairing(pairing, options = {}) {
    const maxAttempts = options.maxAttempts ?? 6;
    const sleep = options.sleep ?? sleepFor;
    const buffer = new CaptureBuffer(pairingDirectory(pairing.key));
    const credential = await credentialFor(pairing);
    if (!credential) {
        await updateState(pairing.key, { state: "expired", last_error: "The credential is missing from the keychain. Pair again." });
        return "stopped";
    }
    for (const sessionId of await buffer.sessionIds()) {
        const record = await buffer.record(sessionId);
        if (!record)
            continue;
        let limit = MAX_BATCH_EVENTS;
        let failures = 0;
        for (let pending = await buffer.pending(sessionId); pending.length; pending = await buffer.pending(sessionId)) {
            const state = await readState(pairing.key);
            if (state.expires_at && (options.now ?? Date.now)() >= Date.parse(state.expires_at) + UPLOAD_GRACE_MS)
                return "stopped";
            const end = state.expires_at ? Date.parse(state.expires_at) : Infinity;
            // Cached active hooks can race the end. Drop those events locally so they
            // cannot make the API reject otherwise eligible pre-end evidence.
            if (Date.parse(pending[0].occurred_at) > end) {
                await buffer.acknowledge(sessionId, pending[0].sequence, 1);
                continue;
            }
            const firstPostEnd = pending.findIndex((event) => Date.parse(event.occurred_at) > end);
            const events = batchOf(firstPostEnd === -1 ? pending : pending.slice(0, firstPostEnd), limit);
            try {
                const results = await uploadBatch(pairing.api_url, pairing.attempt_id, credential, {
                    session: record.session, producer: PRODUCER, sent_at: new Date().toISOString(),
                    events: events,
                });
                // Accepted and duplicate events are stored; rejected ones can never be (sequence conflicts).
                const rejected = results.filter((result) => result.status === "rejected").length;
                await buffer.acknowledge(sessionId, events.at(-1).sequence, rejected);
                await updateState(pairing.key, { last_upload_at: new Date().toISOString(), last_error: rejected ? `The API rejected ${rejected} event(s).` : null });
                failures = 0;
                continue;
            }
            catch (error) {
                const status = error instanceof ApiError ? error.status : null;
                if (status === 413) {
                    if (events.length > 1) {
                        limit = Math.max(1, Math.floor(events.length / 2));
                        continue;
                    }
                    await buffer.acknowledge(sessionId, events[0].sequence, 1); // A single event over the limit can never be sent.
                    continue;
                }
                if (status === 401 || status === 409) {
                    await refreshState(pairing).catch(() => null);
                    await updateState(pairing.key, { last_error: `Upload stopped: the API answered ${status}.` });
                    return "stopped";
                }
                else if (status !== null && status !== 429 && status < 500) {
                    await updateState(pairing.key, { last_error: `Upload failed: ${error instanceof Error ? error.message : "unexpected response"}.` });
                    return "gave-up";
                }
                const latest = await readState(pairing.key);
                const now = (options.now ?? Date.now)();
                const end = latest.expires_at ? Date.parse(latest.expires_at) : Infinity;
                const remaining = end + UPLOAD_GRACE_MS - now;
                if (remaining <= 0)
                    return "stopped";
                // Active uploads yield after maxAttempts. At expiry, keep retrying
                // while a known grace deadline still permits the buffered evidence.
                const withinGrace = Number.isFinite(remaining) && (latest.state === "expired" || now >= end);
                if (++failures >= maxAttempts && !withinGrace) {
                    await updateState(pairing.key, { last_error: "Upload failed after retries; events stay buffered and are retried on the next hook." });
                    return "gave-up";
                }
                await sleep(Math.min(remaining, 30_000, 1_000 * 2 ** (failures - 1)));
            }
        }
    }
    return "done";
}
function batchOf(events, limit) {
    const batch = [];
    let bytes = 0;
    for (const event of events.slice(0, limit)) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (batch.length && bytes > MAX_BATCH_BYTES)
            break;
        batch.push(event);
    }
    return batch;
}
/**
 * Upload in this process while holding the pairing's upload lock. Returns
 * without uploading when another uploader holds it. After releasing, re-checks
 * the buffer: a hook may have appended while its own uploader found the lock taken.
 */
export async function uploadWithLock(pairing, options = {}) {
    const lock = join(pairingDirectory(pairing.key), "upload.pid");
    const buffer = new CaptureBuffer(pairingDirectory(pairing.key));
    for (;;) {
        if (!await withFileLock(`${lock}.start`, () => acquire(lock)))
            return;
        let result;
        try {
            result = await flushPairing(pairing, options);
        }
        finally {
            await unlink(lock).catch(() => { });
        }
        if (result !== "done" || !await buffer.bufferedCount())
            return;
    }
}
/** Serialize credential replacement with any uploader already draining this binding. */
export async function replaceWithLock(pairing, action) {
    const lock = join(pairingDirectory(pairing.key), "upload.pid");
    if (!await withFileLock(`${lock}.start`, () => acquire(lock)))
        throw new Error("An upload is still running. Retry pairing once it finishes.");
    try {
        await action();
    }
    finally {
        await unlink(lock).catch(() => { });
    }
}
async function acquire(lock) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(lock, "wx", 0o600);
            await handle.writeFile(String(process.pid));
            await handle.close();
            return true;
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                throw error;
            const owner = await readFile(lock, "utf8").catch(() => "");
            const pid = Number(owner.split(":")[0]);
            if (pid === process.pid && owner.endsWith(":starting")) {
                const handle = await open(lock, "w", 0o600);
                try {
                    await handle.writeFile(String(process.pid));
                }
                finally {
                    await handle.close();
                }
                return true;
            }
            if (pid && alive(pid))
                return false;
            await unlink(lock).catch(() => { }); // Left by a crashed uploader.
        }
    }
    return false;
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}
/** Start a detached uploader so the hook returns immediately. */
export async function spawnUploader(pairing) {
    const lock = join(pairingDirectory(pairing.key), "upload.pid");
    await withFileLock(`${lock}.start`, async () => {
        if (!await acquire(lock))
            return;
        try {
            const child = spawn(process.execPath, [fileURLToPath(new URL("./upload.js", import.meta.url)), pairing.key], { detached: true, stdio: "ignore" });
            await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
            const handle = await open(lock, "w", 0o600);
            try {
                await handle.writeFile(`${child.pid}:starting`);
            }
            finally {
                await handle.close();
            }
            child.unref();
        }
        catch (error) {
            await unlink(lock).catch(() => { });
            throw error;
        }
    });
}
