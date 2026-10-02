import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
const SERVICE = "ignsight";
const LABEL = "Ignsight capture credential";
/** Store `secret` for `account`, in the keychain when possible, else in `fallbackFile`. */
export async function storeSecret(account, secret, fallbackFile) {
    try {
        if (process.platform === "darwin") {
            // `security -i` reads commands from stdin. Accounts are hex and secrets are base64url, so no quoting is needed.
            await run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${account} -l "${LABEL}" -w ${secret}\n`);
        }
        else if (process.platform === "linux") {
            await run("secret-tool", ["store", `--label=${LABEL}`, "service", SERVICE, "account", account], secret);
        }
        else
            throw new Error("no supported keychain");
        // `security -i` exits 0 even when a command fails, so read the secret back.
        if (await keychainSecret(account) === secret) {
            await unlink(fallbackFile).catch(() => { });
            return "keychain";
        }
    }
    catch { /* Fall through to the file. */ }
    await writeFile(fallbackFile, secret, { mode: 0o600 });
    return "file";
}
/** Read a stored secret, or null when it is gone. */
export async function readSecret(account, storage, fallbackFile) {
    if (storage === "file")
        return readFile(fallbackFile, "utf8").catch(() => null);
    return keychainSecret(account).catch(() => null);
}
/** Remove both credential stores, including a fallback left by an earlier pairing. */
export async function deleteSecret(account, fallbackFile) {
    try {
        if (process.platform === "darwin")
            await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
        else if (process.platform === "linux")
            await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
    }
    catch { /* A missing keychain entry is already deleted; verify below. */ }
    await unlink(fallbackFile).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    });
    if (await keychainSecret(account).catch(() => null))
        throw new Error("Could not remove the capture credential from the keychain.");
}
async function keychainSecret(account) {
    const output = process.platform === "darwin"
        ? await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
        : await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
    return output.replace(/\n$/, "");
}
function run(command, args, input = "") {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], timeout: 5_000 });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.on("error", reject);
        // A command that exits without reading stdin (`secret-tool lookup`) breaks the pipe; its exit code decides.
        child.stdin.on("error", () => { });
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`)));
        child.stdin.end(input);
    });
}
