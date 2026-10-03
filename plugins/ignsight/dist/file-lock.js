import { open, readFile, stat, unlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
/**
 * Run `action` while holding an exclusive lock file, serializing it across processes.
 * A lock older than 2s is reclaimed only if its owner is gone; waiting gives up after 2.4s so a hook
 * stays inside its 3s budget.
 */
export async function withFileLock(path, action) {
    const deadline = Date.now() + 2400;
    let handle;
    while (!handle) {
        try {
            handle = await open(path, "wx", 0o600);
            await handle.writeFile(String(process.pid));
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                throw error;
            const current = await stat(path).catch(() => null);
            if (current && Date.now() - current.mtimeMs > 2000) {
                const pid = Number(await readFile(path, "utf8").catch(() => ""));
                let alive = false;
                if (Number.isSafeInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                        alive = true;
                    }
                    catch (error) {
                        alive = error instanceof Error && "code" in error && error.code === "EPERM";
                    }
                }
                if (!alive)
                    await unlink(path).catch(() => { });
            }
            if (Date.now() >= deadline)
                throw new Error(`lock timeout: ${path}`, { cause: error });
            await setTimeout(20);
        }
    }
    try {
        return await action();
    }
    finally {
        // A stale owner must not remove a replacement owner's lock.
        const current = await stat(path).catch(() => null);
        if (current?.ino === (await handle.stat()).ino)
            await unlink(path).catch(() => { });
        await handle.close();
    }
}
