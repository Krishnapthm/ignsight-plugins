import { resolve } from "node:path";
import { CaptureBuffer } from "./buffer.js";
import { refreshState } from "./capture.js";
import { connectCommands, displayName } from "./agents/index.js";
import { describeState, pairWorkspace } from "./pair.js";
import { uploadWithLock } from "./uploader.js";
import { isInside, listPairings, pairingDirectory, readState } from "./workspace.js";
// `cli.js pair <pairing code> [--root <workspace>]`: pair this workspace with an attempt from a terminal.
//   Inside a coding agent, the UserPromptSubmit hook pairs instead (src/pair.ts).
// `cli.js status [--root <workspace>] [--json] [--all]`: show the newest pairing per agent, or every pairing with --all.
async function main() {
    const [command, ...args] = process.argv.slice(2);
    const rootIndex = args.indexOf("--root");
    const rootOption = rootIndex === -1 ? undefined : args.splice(rootIndex, 2)[1];
    if (rootIndex !== -1 && !rootOption)
        throw new Error("--root needs a directory");
    const directory = resolve(rootOption ?? process.cwd());
    if (command === "pair" && args.length === 1)
        await pair(args[0], directory);
    else if (command === "status" && args.every((arg) => arg === "--json" || arg === "--all"))
        await status(directory, args.includes("--json"), args.includes("--all"));
    else
        throw new Error("Usage: cli.js pair <pairing code> [--root <workspace>] | cli.js status [--root <workspace>] [--json] [--all]");
}
async function pair(token, directory) {
    const { lines, warning } = await pairWorkspace(token, directory);
    for (const line of lines)
        console.log(line);
    if (warning)
        console.error(warning);
}
/** The newest pairing per coding agent; older attempts are history, shown with --all. */
function latestPerProducer(pairings) {
    const newest = new Map();
    for (const pairing of pairings)
        if ((newest.get(pairing.producer)?.paired_at ?? "") < pairing.paired_at)
            newest.set(pairing.producer, pairing);
    return [...newest.values()];
}
async function status(directory, json, all) {
    const matching = (await listPairings()).filter((pairing) => isInside(directory, pairing.root) || isInside(pairing.root, directory));
    if (!matching.length) {
        if (json) {
            console.log("[]");
            return;
        }
        console.log(`Not paired: ${directory}\nPair with ${connectCommands()}, using the pairing code from the candidate portal, in your assignment workspace.`);
        return;
    }
    const pairings = all ? matching : latestPerProducer(matching);
    const reports = [];
    for (const pairing of pairings.sort((a, b) => b.paired_at.localeCompare(a.paired_at))) {
        let state = await refreshState(pairing).catch(() => readState(pairing.key));
        let refreshError = null;
        try {
            if (state.state === "expired" || (state.state !== "ended" && state.expires_at && Date.parse(state.expires_at) <= Date.now())) {
                await uploadWithLock(pairing);
                state = await readState(pairing.key);
            }
        }
        catch (error) {
            // A coding agent's sandbox may deny writes to the data directory; the cached state is still accurate to report.
            refreshError = `could not finish ending the attempt here (${error instanceof Error ? error.message : "unknown error"}); the next hook or a terminal status will retry`;
        }
        const storage = pairing.credential_storage === "file" ? "file fallback warning: credential stored in an owner-only file" : "keychain";
        const report = {
            producer: pairing.producer, workspace_root: pairing.root, attempt_id: pairing.attempt_id,
            state: describeState(state.state, state.ended_at ?? state.expires_at), valid_until: state.expires_at,
            last_successful_upload: state.last_upload_at,
            buffered_count: await new CaptureBuffer(pairingDirectory(pairing.key)).bufferedCount(),
            credential_storage: state.state === "ended" ? `removed (${storage})` : storage,
            last_error: refreshError ?? state.last_error, end_reason: state.end_reason,
            uploaded_events: state.uploaded_events, dropped_events: state.dropped_events,
        };
        reports.push(report);
        if (!json)
            console.log([
                `Producer: ${displayName(pairing.producer)}`,
                `  Workspace root: ${report.workspace_root}`,
                `  Attempt: ${report.attempt_id}`,
                `  State: ${report.state}`,
                `  Valid until: ${report.valid_until ?? "unknown"}`,
                `  Last upload: ${report.last_successful_upload ?? "never"}`,
                `  Buffered events: ${report.buffered_count}`,
                `  Credential storage: ${report.credential_storage}`,
                `  Last error: ${report.last_error ?? "none"}`,
                ...state.state === "ended" ? [`  End reason: ${state.end_reason}`, `  Uploaded events: ${state.uploaded_events}`, `  Dropped events: ${state.dropped_events}`] : [],
            ].join("\n"));
    }
    const hidden = matching.length - pairings.length;
    if (!json && hidden)
        console.log(`${hidden} older pairing${hidden === 1 ? "" : "s"} hidden; run status --all to list them.`);
    if (json)
        console.log(JSON.stringify(reports, null, 2));
}
try {
    await main();
}
catch (error) {
    console.error(error instanceof Error ? error.message : "capture CLI failed");
    process.exitCode = 1;
}
