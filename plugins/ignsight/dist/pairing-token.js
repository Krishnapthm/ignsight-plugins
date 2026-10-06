// The candidate portal shows one opaque pairing token per producer instead of a
// separate API URL and code: `ignsight1_` + base64url(JSON {api, producer, code}).
// The portal (apps/web) encodes it; the capture client and the extension decode it.
// The code inside is single use and expires within five minutes.
/** How a candidate pairs from each host: Claude Code skills use `/`, Codex skills `$`. */
export const CONNECT_COMMANDS = "/ignsight:connect <code> in Claude Code or $ignsight:connect <code> in Codex";
const PREFIX = "ignsight1_";
const producers = new Set(["codex", "claude_code", "extension"]);
/** Decode and validate a pairing token. Throws a candidate-readable error. */
export function parsePairingToken(token) {
    const text = token.trim();
    if (!text.startsWith(PREFIX))
        throw new Error("This is not an Ignsight pairing code. Copy it again from the candidate portal.");
    let value;
    try {
        value = JSON.parse(Buffer.from(text.slice(PREFIX.length), "base64url").toString("utf8"));
    }
    catch {
        throw new Error("The pairing code is incomplete. Copy it again from the candidate portal.");
    }
    if (typeof value !== "object" || value === null)
        throw new Error("The pairing code is malformed.");
    const { api, producer, code } = value;
    if (typeof api !== "string" || typeof producer !== "string" || !producers.has(producer) || typeof code !== "string" || !code) {
        throw new Error("The pairing code is malformed.");
    }
    return { api: apiOrigin(api), producer: producer, code };
}
/** The API origin, allowing plain http only for loopback development APIs. */
export function apiOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("The pairing code has an invalid API address.");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
        throw new Error("The pairing code has an invalid API address.");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
