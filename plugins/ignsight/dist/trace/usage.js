import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isObject } from "./event.js";
import { isSensitiveFile } from "./scope.js";
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
/** Stream new complete JSONL records under a fixed byte budget; malformed data is ignored. */
export async function readUsage(input, previous) {
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
        let usage;
        // The 16 MiB Stop window bounds this map; no response IDs survive in metadata.
        const claudeResponses = new Map();
        const effort = isObject(input.payload.effort) ? shortText(input.payload.effort.level) : undefined;
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
                        const next = extract(value, input, cursor);
                        if (next) {
                            if (input.source === "claude-code") {
                                const id = isObject(value) && isObject(value.message) ? value.message.id : undefined;
                                // Map replacement keeps distinct responses in their first-seen order.
                                claudeResponses.set(typeof id === "string" ? id : Symbol(), next);
                            }
                            else
                                usage = sumUsage(usage, next);
                        }
                    }
                    cursor.offset = chunkStart + boundary;
                    parts = [];
                    length = 0;
                }
                start = boundary;
            }
        }
        for (const response of claudeResponses.values())
            usage = sumUsage(usage, response);
        if (usage && effort && input.source === "claude-code")
            usage.reasoning_effort = effort;
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
/** Pick only the host's numeric counters and model metadata from an unknown JSON record. */
function extract(value, input, cursor) {
    if (!isObject(value))
        return undefined;
    if (input.source === "claude-code") {
        if (value.type !== "assistant" || !isObject(value.message) || !isObject(value.message.usage))
            return undefined;
        const model = shortText(value.message.model);
        return model ? counters(value.message.usage, model, "cache_read_input_tokens", "cache_creation_input_tokens") : undefined;
    }
    if (value.type === "turn_context" && isObject(value.payload)) {
        cursor.model = shortText(value.payload.model);
        cursor.effort = shortText(value.payload.effort ?? value.payload.reasoning_effort);
        return undefined;
    }
    if (value.type !== "event_msg" || !isObject(value.payload) || value.payload.type !== "token_count" || !isObject(value.payload.info))
        return undefined;
    const info = value.payload.info;
    if (!isObject(info.last_token_usage))
        return undefined;
    const model = cursor.model ?? shortText(input.model);
    if (!model)
        return undefined;
    const next = counters(info.last_token_usage, model, "cached_input_tokens");
    if (!next)
        return undefined;
    // Codex input_tokens includes cached input; normalize to uncached input plus cache reads.
    if (next.cache_read_tokens !== undefined) {
        if (next.cache_read_tokens > next.input_tokens)
            return undefined;
        next.input_tokens -= next.cache_read_tokens;
    }
    if (isObject(info.total_token_usage)) {
        const total = info.total_token_usage;
        if (count(total.input_tokens) !== undefined && count(total.output_tokens) !== undefined) {
            const signature = `${total.input_tokens}:${total.output_tokens}:${count(total.cached_input_tokens) ?? ""}`;
            if (signature === cursor.totals)
                return undefined; // Rate-limit updates can repeat the latest usage.
            cursor.totals = signature;
        }
    }
    cursor.window = count(info.model_context_window) ?? cursor.window;
    next.context_window = cursor.window;
    next.reasoning_effort = cursor.effort;
    return next;
}
/** Sum distinct requests while keeping context and model from the last request. */
function sumUsage(current, next) {
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
/** Required counters must be real non-negative integers; unknown optional counters stay absent. */
function counters(value, model, read, write) {
    const input = count(value.input_tokens), output = count(value.output_tokens);
    if (input === undefined || output === undefined)
        return undefined;
    const cached = count(value[read]);
    return {
        model, input_tokens: input, output_tokens: output,
        ...(cached !== undefined && { cache_read_tokens: cached }),
        ...(write && count(value[write]) !== undefined && { cache_write_tokens: count(value[write]) }),
        context_tokens: input + (read === "cached_input_tokens" ? 0 : cached ?? 0),
    };
}
function count(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function shortText(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : undefined;
}
