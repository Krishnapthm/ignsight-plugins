import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { connectCommands } from "./agents/index.js";
/** The OS user data directory for Ignsight state. */
export function dataDirectory() {
    const home = homedir();
    if (process.platform === "darwin")
        return join(home, "Library", "Application Support", "Ignsight");
    if (process.platform === "win32")
        return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Ignsight");
    const xdg = process.env.XDG_DATA_HOME;
    return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "ignsight");
}
export function pairingsDirectory() {
    return join(dataDirectory(), "capture");
}
export function pairingDirectory(key) {
    return join(pairingsDirectory(), key);
}
export function isInside(path, root) {
    return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
export function pairingKey(producer, root, attemptId) {
    return createHash("sha256").update(`${producer}\n${root}\n${attemptId}`).digest("hex").slice(0, 32);
}
/** Resolve a workspace root, refusing the home directory and its ancestors. */
export async function workspaceRoot(directory) {
    const root = await realpath(directory);
    const home = await realpath(homedir()).catch(() => homedir());
    // Pairing home or an ancestor would authorize every repository below it.
    if (isInside(home, root))
        throw new Error(`refusing to pair ${root}: it contains the home directory. Run this in the assignment workspace.`);
    return root;
}
/**
 * Prove the data directory is writable before a single-use pairing code is
 * spent. A coding agent's sandbox may deny writes there to commands the model
 * runs; hooks run outside it.
 */
export async function assertWritableDataDirectory() {
    const probe = join(pairingsDirectory(), `.probe-${process.pid}`);
    try {
        await ownerOnlyDirectory(dataDirectory());
        await ownerOnlyDirectory(pairingsDirectory());
        await writeFile(probe, "", { mode: 0o600 });
        await rm(probe, { force: true });
    }
    catch (error) {
        const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
        throw new Error(`Ignsight cannot write its pairing data in ${dataDirectory()}${code}, so the pairing code was not used. If a coding agent ran \`cli.js pair\` inside its sandbox, pair with ${connectCommands()} instead, or run it from a terminal.`, { cause: error });
    }
}
/** Create the owner-only pairing directory and write its record. */
export async function savePairing(pairing) {
    await ownerOnlyDirectory(dataDirectory());
    await ownerOnlyDirectory(pairingsDirectory());
    await ownerOnlyDirectory(pairingDirectory(pairing.key));
    await writeJson(join(pairingDirectory(pairing.key), "pairing.json"), pairing);
}
/** Every stored pairing. Unreadable records are skipped. */
export async function listPairings() {
    let keys;
    try {
        keys = await readdir(pairingsDirectory());
    }
    catch {
        return [];
    }
    const pairings = await Promise.all(keys.map(async (key) => {
        try {
            const value = JSON.parse(await readFile(join(pairingDirectory(key), "pairing.json"), "utf8"));
            return value.version === 1 && value.key === key ? value : null;
        }
        catch {
            return null;
        }
    }));
    return pairings.filter((pairing) => pairing !== null);
}
/** The pairing that authorizes `producer` in `cwd`: innermost root first, then the newest. */
export async function findPairing(cwd, producer) {
    let path;
    try {
        path = await realpath(cwd);
    }
    catch {
        return null;
    }
    const matches = (await listPairings()).filter((pairing) => pairing.producer === producer && isInside(path, pairing.root));
    return matches.sort((a, b) => b.root.length - a.root.length || b.paired_at.localeCompare(a.paired_at))[0] ?? null;
}
export async function readState(key) {
    const empty = { state: null, checked_at: null, expires_at: null, last_upload_at: null, last_error: null, ended_at: null, end_reason: null, uploaded_events: 0, dropped_events: 0 };
    try {
        return { ...empty, ...JSON.parse(await readFile(join(pairingDirectory(key), "state.json"), "utf8")) };
    }
    catch {
        return empty;
    }
}
/** Merge `update` into the stored state. Last writer wins; the state is a cache, not evidence. */
export async function updateState(key, update) {
    const next = { ...await readState(key), ...update };
    await writeJson(join(pairingDirectory(key), "state.json"), next);
    return next;
}
async function ownerOnlyDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
}
/** Atomic owner-only JSON write. */
export async function writeJson(path, value) {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}
