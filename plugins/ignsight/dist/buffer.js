import { appendFile, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";
import { assertSafeSessionId } from "./trace/event.js";
import { writeJson } from "./workspace.js";
export class CaptureBuffer {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    /** Serialize buffer changes across hook and uploader processes. */
    async withLock(action) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        return withFileLock(join(this.directory, ".buffer.lock"), action);
    }
    /**
     * Append drafts to a session, assigning sequences and `occurred_at`.
     * `opening` drafts are added first when the session is new.
     */
    async append(session, drafts, opening = [], now = new Date()) {
        return this.withLock(async () => {
            const directory = await this.sessionDirectory(session.client_session_id);
            const path = join(directory, "events.jsonl");
            const stored = await this.record(session.client_session_id) ?? { session, last_sequence: 0, acknowledged: 0, rejected: 0 };
            // `session.json` advances after the events are written, so a killed hook can leave
            // events ahead of it. Never reuse their sequences.
            const persisted = await persistedTail(path);
            const record = { ...stored, last_sequence: Math.max(stored.last_sequence, persisted.highest) };
            const all = record.last_sequence === 0 ? [...opening, ...drafts] : drafts;
            const events = all.map((draft, index) => ({ ...draft, sequence: record.last_sequence + index + 1, occurred_at: now.toISOString() }));
            if (!events.length)
                return events;
            // A torn final line must not swallow the first new event.
            const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
            await appendFile(path, persisted.torn ? `\n${lines}` : lines, { mode: 0o600 });
            await chmod(path, 0o600);
            // The model can appear after the session started; keep the latest known one.
            await writeJson(join(directory, "session.json"), {
                ...record, session: { ...record.session, ...session.model_name && { model_name: session.model_name } }, last_sequence: events.at(-1).sequence,
            });
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
    async record(sessionId) {
        assertSafeSessionId(sessionId);
        try {
            return JSON.parse(await readFile(join(this.directory, "sessions", sessionId, "session.json"), "utf8"));
        }
        catch {
            return null;
        }
    }
    /** Buffered events of a session that the API has not acknowledged, in sequence order. */
    async pending(sessionId) {
        const record = await this.record(sessionId);
        if (!record)
            return [];
        let text;
        try {
            text = await readFile(join(this.directory, "sessions", sessionId, "events.jsonl"), "utf8");
        }
        catch {
            return [];
        }
        const events = [];
        for (const line of text.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const event = JSON.parse(line);
                if (event.sequence > record.acknowledged)
                    events.push(event);
            }
            catch { /* A torn final line from a killed hook; it was never acknowledged either. */ }
        }
        return events.sort((a, b) => a.sequence - b.sequence);
    }
    /** Record the API's answer for every event up to `sequence` and drop them from the buffer. */
    async acknowledge(sessionId, sequence, rejected) {
        await this.withLock(async () => {
            const record = await this.record(sessionId);
            if (!record || sequence <= record.acknowledged)
                return;
            const next = { ...record, acknowledged: sequence, rejected: record.rejected + rejected };
            const directory = join(this.directory, "sessions", sessionId);
            const remaining = (await this.pending(sessionId)).filter((event) => event.sequence > sequence);
            const temporary = join(directory, `events.jsonl.${process.pid}.tmp`);
            await writeFile(temporary, remaining.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
            await rename(temporary, join(directory, "events.jsonl"));
            await writeJson(join(directory, "session.json"), next);
        });
    }
    /** Events waiting for upload across every session. */
    async bufferedCount() {
        let count = 0;
        for (const sessionId of await this.sessionIds())
            count += (await this.pending(sessionId)).length;
        return count;
    }
    async sessionDirectory(sessionId) {
        assertSafeSessionId(sessionId);
        const sessions = join(this.directory, "sessions");
        const directory = join(sessions, sessionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(sessions, 0o700);
        await chmod(directory, 0o700);
        return directory;
    }
}
/** Highest sequence in an events file, and whether it ends mid-line (a killed append). */
async function persistedTail(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return { highest: 0, torn: false };
    }
    let highest = 0;
    for (const line of text.split("\n")) {
        try {
            const sequence = JSON.parse(line).sequence;
            if (Number.isSafeInteger(sequence) && sequence > highest)
                highest = sequence;
        }
        catch { /* blank or torn line */ }
    }
    return { highest, torn: text.length > 0 && !text.endsWith("\n") };
}
