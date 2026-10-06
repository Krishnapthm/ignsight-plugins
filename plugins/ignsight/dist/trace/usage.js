import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isObject } from "./event.js";
import { isSensitiveFile } from "./scope.js";
// Bounded, agent-neutral transcript reading. The agent's adapter supplies a
// `UsageReader` that understands its transcript format; this module owns the
// file I/O, the byte budgets and the cursor between hooks.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
/** Validate owner-only metadata before using it as a transcript cursor. */
export function validCursor(value) {
    return isObject(value) && typeof value.identity === "string" && value.identity.length <= 255 && count(value.offset) !== undefined
        && [value.model, value.effort, value.totals].every((item) => item === undefined || typeof item === "string" && item.length <= 255)
        && (value.window === undefined || count(value.window) !== undefined);
}
/** Establish a prompt boundary without reading historical or pre-authorization transcript content. */
export async function transcriptBoundary(path) {
    if (!path)
        return undefined;
    const file = await stat(path).catch(() => null);
    return file?.isFile() ? { identity: `${file.dev}:${file.ino}`, offset: file.size } : undefined;
}
/**
 * Stream new complete JSONL records under a fixed byte budget into the agent's
 * usage reader; malformed data is ignored.
 */
export async function readUsage(input, reader, previous) {
    if (!input.transcriptPath)
        return {};
    const path = await realpath(input.transcriptPath).catch(() => null);
    if (!path || isSensitiveFile(input.transcriptPath) || isSensitiveFile(path))
        return {};
    // Nonblocking open lets us reject FIFOs and devices without waiting for a producer.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
    if (!handle)
        return {};
    try {
        const file = await handle.stat();
        if (!file.isFile())
            return {};
        const identity = `${file.dev}:${file.ino}`;
        const cursor = previous?.identity === identity && previous.offset <= file.size
            ? { ...previous } : { identity, offset: 0 };
        if (file.size - cursor.offset > MAX_SCAN_BYTES)
            return { cursor: { identity, offset: file.size }, limited: true };
        let parts = [], length = 0, limited = false;
        const chunk = Buffer.alloc(64 * 1024);
        for (let position = cursor.offset; position < file.size;) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, file.size - position), position);
            if (!bytesRead)
                break;
            const chunkStart = position;
            position += bytesRead;
            for (let start = 0; start < bytesRead;) {
                const end = chunk.subarray(0, bytesRead).indexOf(10, start);
                const boundary = end === -1 ? bytesRead : end + 1;
                length += boundary - start;
                if (length <= MAX_LINE_BYTES)
                    parts.push(Buffer.from(chunk.subarray(start, boundary)));
                else {
                    parts = [];
                    limited = true;
                }
                if (end !== -1) {
                    if (length <= MAX_LINE_BYTES) {
                        let value;
                        try {
                            value = JSON.parse(Buffer.concat(parts).toString("utf8"));
                        }
                        catch { /* Skip malformed complete records. */ }
                        reader.add(value, cursor);
                    }
                    cursor.offset = chunkStart + boundary;
                    parts = [];
                    length = 0;
                }
                start = boundary;
            }
        }
        let usage = reader.total();
        if (usage && !Object.values(usage).every((value) => typeof value !== "number" || count(value) !== undefined))
            usage = undefined;
        return { cursor, usage: limited ? undefined : usage, limited };
    }
    catch {
        return {};
    }
    finally {
        await handle.close();
    }
}
/** Sum distinct requests while keeping context and model from the last request. */
export function sumUsage(current, next) {
    if (!current)
        return { ...next };
    current.model = next.model;
    current.input_tokens += next.input_tokens;
    current.output_tokens += next.output_tokens;
    for (const key of ["cache_read_tokens", "cache_write_tokens"]) {
        if (next[key] !== undefined)
            current[key] = (current[key] ?? 0) + next[key];
    }
    current.context_tokens = next.context_tokens;
    current.context_window = next.context_window;
    current.reasoning_effort = next.reasoning_effort;
    return current;
}
/**
 * Required counters must be real non-negative integers; unknown optional
 * counters stay absent. `read` and `write` name the agent's cache-read and
 * cache-write counters. With `cacheInInput`, the cache-read counter is already
 * part of input, so it does not add to the context.
 */
export function counters(value, model, read, write, cacheInInput = false) {
    const input = count(value.input_tokens), output = count(value.output_tokens);
    if (input === undefined || output === undefined)
        return undefined;
    const cached = count(value[read]);
    return {
        model, input_tokens: input, output_tokens: output,
        ...(cached !== undefined && { cache_read_tokens: cached }),
        ...(write && count(value[write]) !== undefined && { cache_write_tokens: count(value[write]) }),
        context_tokens: input + (cacheInInput ? 0 : cached ?? 0),
    };
}
export function count(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function shortText(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : undefined;
}
