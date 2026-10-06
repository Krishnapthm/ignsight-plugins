import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validCursor } from "./trace/usage.js";
import { withFileLock } from "./file-lock.js";
import { assertSafeSessionId } from "./trace/event.js";
import { writeJson } from "./workspace.js";
// Owner-only local upload buffer (directories 0700, files 0600):
//   sessions/<id>/events.jsonl: canonical events, including an acknowledged prefix.
//   sessions/<id>/session.json: BatchSession and durable bookkeeping below.
// last_sequence is the highest reserved idempotency key, never reused even after
// an interrupted append. acknowledged is the highest sequence answered by the
// API; rejected counts its rejected events. acknowledged_offset is the byte
// boundary already answered or skipped as corrupt. file_bytes counts complete
// committed lines; buffered_count counts valid unacknowledged events.
// capacity_warning pauses new events after the single full-buffer warning.
// compacting journals the old file size and prefix offset across a tail rename.
// Valid events leave only after the API answered accepted, duplicate or rejected;
// compaction preserves unacknowledged bytes and source-local sequences exactly.
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_BATCH_BYTES;
const DEFAULT_LIMITS = { bytes: 50 * 1024 * 1024, events: 100_000 };
export class CaptureBuffer {
    directory;
    limits;
    constructor(directory, limits = DEFAULT_LIMITS) {
        this.directory = directory;
        this.limits = limits;
    }
    /** Serialize buffer changes across hook and uploader processes. */
    async withLock(action) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        return withFileLock(join(this.directory, ".buffer.lock"), action);
    }
    /** Append redacted drafts without reading the backlog; reserve sequences before writing. */
    async append(session, drafts, opening = [], now = new Date()) {
        return this.withLock(async () => {
            const directory = await this.sessionDirectory(session.client_session_id);
            const path = join(directory, "events.jsonl");
            const record = await this.recover(session.client_session_id) ?? {
                session, last_sequence: 0, acknowledged: 0, rejected: 0, acknowledged_offset: 0,
                file_bytes: 0, buffered_count: 0, capacity_warning: false,
            };
            const prepared = typeof drafts === "function" ? await drafts(record) : drafts;
            const all = record.last_sequence === 0 ? [...opening, ...prepared] : prepared;
            const events = [];
            const acceptedLines = [];
            let bytes = record.file_bytes;
            let count = record.buffered_count;
            let full = record.capacity_warning;
            for (const draft of all) {
                if (full)
                    break;
                let event = { ...draft, sequence: record.last_sequence + events.length + 1, occurred_at: draft.occurred_at ?? now.toISOString() };
                let line = `${JSON.stringify(event)}\n`;
                if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
                    event = { sequence: event.sequence, occurred_at: event.occurred_at, event_type: "capture.warning", actor: "system", payload: { code: "event_too_large", message: "An event exceeded the local line limit and was dropped." } };
                    line = `${JSON.stringify(event)}\n`;
                }
                // Reserve one event and 1 KiB for the capacity warning inside the cap.
                if (count >= this.limits.events - 1 || bytes + Buffer.byteLength(line) > this.limits.bytes - 1024) {
                    event = { sequence: event.sequence, occurred_at: event.occurred_at, event_type: "capture.warning", actor: "system", payload: { code: "event_capacity_reached", message: "The local buffer is full; new events are dropped until uploads resume." } };
                    line = `${JSON.stringify(event)}\n`;
                    full = true;
                }
                events.push(event);
                acceptedLines.push(line);
                bytes += Buffer.byteLength(line);
                count++;
            }
            if (!events.length) {
                await this.save(session.client_session_id, record);
                return events;
            }
            record.last_sequence = events.at(-1).sequence;
            if (session.model_name)
                record.session = { ...record.session, model_name: session.model_name };
            // Reserve all keys before the one append; recovery counts complete new lines.
            await this.save(session.client_session_id, record);
            const handle = await open(path, "a", 0o600);
            try {
                await handle.chmod(0o600);
                await handle.writeFile(acceptedLines.join(""));
            }
            finally {
                await handle.close();
            }
            record.file_bytes = bytes;
            record.buffered_count = count;
            record.capacity_warning = full;
            await this.save(session.client_session_id, record);
            return events;
        });
    }
    async sessionIds() {
        try {
            return (await readdir(join(this.directory, "sessions"))).sort();
        }
        catch {
            return [];
        }
    }
    /** Read metadata, validating the persisted counters at the local boundary. */
    async record(sessionId) {
        assertSafeSessionId(sessionId);
        let value;
        try {
            value = JSON.parse(await readFile(join(this.directory, "sessions", sessionId, "session.json"), "utf8"));
        }
        catch {
            return null;
        }
        if (!value || typeof value !== "object" || !("session" in value) || !value.session || typeof value.session !== "object")
            throw new Error("Invalid buffer metadata");
        const data = value;
        for (const key of ["last_sequence", "acknowledged", "rejected"]) {
            if (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0)
                throw new Error("Invalid buffer counter");
        }
        for (const key of ["acknowledged_offset", "file_bytes", "buffered_count"]) {
            if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0))
                throw new Error("Invalid buffer offset");
        }
        const session = value.session;
        if (session.client_session_id !== sessionId || typeof session.source !== "string" || typeof session.source_kind !== "string")
            throw new Error("Invalid buffer session");
        if (data.capacity_warning !== undefined && typeof data.capacity_warning !== "boolean")
            throw new Error("Invalid capacity marker");
        if (data.compacting !== undefined) {
            const journal = data.compacting;
            if (!journal || typeof journal !== "object" || !("offset" in journal) || !("size" in journal) || !Number.isSafeInteger(journal.offset) || !Number.isSafeInteger(journal.size) || Number(journal.offset) <= 0 || Number(journal.size) < Number(journal.offset))
                throw new Error("Invalid compaction journal");
        }
        if (data.transcript !== undefined && !validCursor(data.transcript))
            throw new Error("Invalid transcript cursor");
        if (data.pending_tests !== undefined && (!Array.isArray(data.pending_tests) || data.pending_tests.length > 128 || !data.pending_tests.every((item) => item !== null && typeof item === "object" && "id" in item && typeof item.id === "string" && item.id.length <= 255 && "runner" in item && typeof item.runner === "string" && item.runner.length <= 255 && "started_at" in item && Number.isSafeInteger(item.started_at) && Number(item.started_at) >= 0)))
            throw new Error("Invalid pending tests");
        return value;
    }
    /** Read only one bounded batch from the acknowledged offset. */
    async pending(sessionId) {
        return this.withLock(async () => {
            const record = await this.recover(sessionId);
            if (!record)
                return [];
            const events = [];
            let bytes = 0;
            let corrupt = false;
            for await (const { event, length } of lines(this.path(sessionId), record.acknowledged_offset)) {
                if (!event) {
                    corrupt = true;
                    continue;
                }
                if (event.sequence <= record.acknowledged)
                    continue;
                if (events.length && bytes + length > MAX_BATCH_BYTES)
                    break;
                events.push(event);
                bytes += length;
                if (events.length >= MAX_BATCH_EVENTS)
                    break;
            }
            if (corrupt)
                await this.recover(sessionId, true);
            return events;
        });
    }
    /** Advance the offset; compact only when the acknowledged prefix exceeds half the file. */
    async acknowledge(sessionId, sequence, rejected) {
        await this.withLock(async () => {
            const record = await this.recover(sessionId);
            if (!record || sequence <= record.acknowledged)
                return;
            let offset = record.acknowledged_offset;
            let removed = 0;
            let answered = record.acknowledged;
            let corrupt = false;
            for await (const { event, length } of lines(this.path(sessionId), offset)) {
                if (event && event.sequence > sequence)
                    break;
                offset += length;
                if (!event) {
                    corrupt = true;
                    continue;
                }
                removed++;
                answered = event.sequence;
                if (event.sequence === sequence)
                    break;
            }
            if (corrupt)
                record.buffered_count = (await this.recover(sessionId, true)).buffered_count;
            record.acknowledged_offset = offset;
            record.buffered_count = Math.max(0, record.buffered_count - removed);
            record.acknowledged = answered;
            record.rejected += rejected;
            await this.save(sessionId, record);
            if (record.acknowledged_offset > record.file_bytes / 2) {
                record.compacting = { offset: record.acknowledged_offset, size: record.file_bytes };
                await this.save(sessionId, record);
                await this.finishCompaction(sessionId, record);
            }
            if (record.buffered_count < this.limits.events - 1 && record.file_bytes < this.limits.bytes - 1024) {
                record.capacity_warning = false;
                await this.save(sessionId, record);
            }
        });
    }
    /** Count waiting events in O(sessions), without opening events files. */
    async bufferedCount() {
        let count = 0;
        for (const id of await this.sessionIds()) {
            const record = await this.record(id);
            if (record)
                count += record.buffered_count ?? Math.max(0, record.last_sequence - record.acknowledged);
        }
        return count;
    }
    path(id) { return join(this.directory, "sessions", id, "events.jsonl"); }
    save(id, record) { return writeJson(join(this.directory, "sessions", id, "session.json"), record); }
    /** Recover only bytes written since the last metadata save; migrate old buffers once. */
    async recover(id, rescan = false) {
        const record = await this.record(id);
        if (!record)
            return null;
        if (record.compacting)
            await this.finishCompaction(id, record);
        const size = (await stat(this.path(id)).catch(() => null))?.size ?? 0;
        const legacy = record.file_bytes === undefined || size < record.file_bytes || rescan;
        if (legacy) {
            record.file_bytes = 0;
            record.acknowledged_offset = 0;
            record.buffered_count = 0;
            record.capacity_warning = false;
        }
        if (size !== record.file_bytes || legacy) {
            for await (const { event, length } of lines(this.path(id), record.file_bytes)) {
                record.file_bytes += length;
                if (!event) {
                    if (!record.buffered_count)
                        record.acknowledged_offset = record.file_bytes;
                    continue;
                }
                record.last_sequence = Math.max(record.last_sequence, event.sequence);
                if (event.sequence > record.acknowledged)
                    record.buffered_count++;
                else
                    record.acknowledged_offset = record.file_bytes;
                if (event.event_type === "capture.warning" && event.payload.code === "event_capacity_reached")
                    record.capacity_warning = true;
            }
            // Discard only a torn final line; its reserved sequence remains consumed.
            const handle = await open(this.path(id), "a", 0o600);
            try {
                await handle.truncate(record.file_bytes);
            }
            finally {
                await handle.close();
            }
            await this.save(id, record);
        }
        return record;
    }
    /** Journal the rename so restart can finish compaction without reserializing events. */
    async finishCompaction(id, record) {
        const { offset, size } = record.compacting;
        const path = this.path(id);
        const temporary = `${path}.compact`;
        const currentSize = (await stat(path)).size;
        if (currentSize !== size && currentSize !== size - offset)
            throw new Error("Invalid compacted buffer size");
        if (currentSize === size) {
            const source = await open(path, "r");
            const target = await open(temporary, "w", 0o600);
            try {
                const chunk = Buffer.alloc(64 * 1024);
                for (let position = offset; position < size;) {
                    const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, size - position), position);
                    if (!bytesRead)
                        throw new Error("Incomplete buffer compaction");
                    await target.writeFile(chunk.subarray(0, bytesRead));
                    position += bytesRead;
                }
            }
            finally {
                await source.close();
                await target.close();
            }
            await rename(temporary, path);
        }
        record.file_bytes = size - offset;
        record.acknowledged_offset = 0;
        delete record.compacting;
        await this.save(id, record);
        await unlink(temporary).catch(() => { });
    }
    async sessionDirectory(id) {
        assertSafeSessionId(id);
        const directory = join(this.directory, "sessions", id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(join(this.directory, "sessions"), 0o700);
        await chmod(directory, 0o700);
        return directory;
    }
}
/** Stream complete lines, skipping corrupt or oversized content with bounded memory. */
async function* lines(path, offset) {
    const handle = await open(path, "r").catch(() => null);
    if (!handle)
        return;
    try {
        const chunk = Buffer.alloc(64 * 1024);
        let parts = [];
        let length = 0;
        for (let position = offset;;) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
            if (!bytesRead)
                break;
            position += bytesRead;
            let start = 0;
            while (start < bytesRead) {
                const end = chunk.subarray(0, bytesRead).indexOf(10, start);
                const boundary = end === -1 ? bytesRead : end + 1;
                length += boundary - start;
                if (length <= MAX_LINE_BYTES)
                    parts.push(Buffer.from(chunk.subarray(start, boundary)));
                else
                    parts = [];
                if (end !== -1) {
                    let event = null;
                    if (length <= MAX_LINE_BYTES) {
                        try {
                            const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
                            if (value && typeof value === "object" && "sequence" in value && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0 && "event_type" in value && typeof value.event_type === "string" && "occurred_at" in value && typeof value.occurred_at === "string" && "payload" in value && value.payload && typeof value.payload === "object")
                                event = value;
                        }
                        catch { /* Complete malformed lines are skipped, but their bytes still count. */ }
                    }
                    yield { event, length };
                    parts = [];
                    length = 0;
                }
                start = boundary;
            }
        }
        // A torn final line is omitted so recovery can truncate it without reusing keys.
    }
    finally {
        await handle.close();
    }
}
