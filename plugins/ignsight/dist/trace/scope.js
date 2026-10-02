import { glob, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isInside } from "../workspace.js";
import { isObject } from "./event.js";
// Tool content is captured only for files inside the workspace root (decision D3)
// and never for credential files. A scoped-out event is kept; its file content
// and tool output are replaced by a marker.
export const OUT_OF_WORKSPACE = "[OUT_OF_WORKSPACE]";
export const SENSITIVE_FILE = "[REDACTED_SENSITIVE_FILE]";
// Keys whose string values locate files rather than carry their content. `workdir` is
// resolved separately, once, against the hook cwd.
const pathKeys = new Set(["file_path", "filePath", "path", "notebook_path", "cwd"]);
const commandKeys = new Set(["command", "cmd"]);
// Tool-input keys that survive when content is dropped.
const locatorKeys = new Set([...pathKeys, ...commandKeys, "workdir", "pattern"]);
// Upper bound on filesystem checks for command arguments and glob matches, to stay inside the
// hook budget. Past it the remaining paths are unverified, so the content is dropped.
const MAX_PATH_CHECKS = 1_024;
// .env*, *.env, SSH keys, *.pem, *.key, auth rc files, and cloud credential stores.
const sensitiveFile = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.env|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]+\.(?:pem|key)|\.npmrc|\.netrc|_netrc|\.pgpass|\.git-credentials|\.aws\/(?:credentials|sso\/cache\/[^/]+)|\.docker\/config\.json|\.kube\/config|\.config\/gcloud\/.+|\.azure\/.+)$/;
/** Return the hook payload with tool content removed when it touches files outside `root` or credential files. */
export async function scopePayload(payload, cwd, root) {
    if (!("tool_input" in payload) && !("tool_response" in payload))
        return payload;
    const input = isObject(payload.tool_input) ? payload.tool_input : {};
    const base = typeof input.workdir === "string" ? resolve(cwd, input.workdir) : cwd;
    const paths = { locators: typeof input.workdir === "string" ? [base] : [], mentions: [] };
    collect(payload.tool_input, undefined, paths);
    collect(payload.tool_response, undefined, paths);
    const marker = await classify(paths, base, root);
    if (!marker)
        return payload;
    const scoped = { ...payload };
    if (isObject(payload.tool_input))
        scoped.tool_input = dropContent(payload.tool_input, marker);
    else if ("tool_input" in payload)
        scoped.tool_input = marker;
    if ("tool_response" in payload)
        scoped.tool_response = marker;
    return scoped;
}
function collect(value, key, paths) {
    if (typeof value === "string") {
        if (isPatch(value))
            paths.locators.push(...patchPaths(value));
        else if (key && pathKeys.has(key))
            paths.locators.push(value);
        else if (key && commandKeys.has(key))
            paths.mentions.push(...commandArguments(value));
        else if (key === "pattern" && /^[/~]/.test(value))
            paths.mentions.push(value);
    }
    else if (Array.isArray(value)) {
        // An argv array: each argument is a word, and a `sh -c` script is parsed as a command.
        if (key && commandKeys.has(key) && value.every((item) => typeof item === "string"))
            paths.mentions.push(...pathWords(value.slice(1)), ...value.flatMap(commandArguments));
        else
            for (const item of value)
                collect(item, undefined, paths);
    }
    else if (isObject(value)) {
        for (const [name, item] of Object.entries(value))
            collect(item, name, paths);
    }
}
async function classify(paths, base, root) {
    let sensitive = false;
    // Explicit file locators are checked even when the file does not exist yet (a Write).
    for (const path of paths.locators) {
        const absolute = resolve(base, expandHome(path));
        const real = await resolveReal(absolute);
        if (!isInside(real, root))
            return OUT_OF_WORKSPACE;
        sensitive ||= isSensitiveFile(absolute) || isSensitiveFile(real);
    }
    // Command arguments are only paths when they exist; `grep "/api/"` must not scope out an event.
    const mentions = [...new Set(paths.mentions)];
    let checks = 0;
    for await (const absolute of mentionTargets(mentions, base)) {
        if (++checks > MAX_PATH_CHECKS)
            return OUT_OF_WORKSPACE;
        const real = await realpath(absolute).catch(() => null);
        if (real && !real.startsWith("/dev/") && !isInside(real, root))
            return OUT_OF_WORKSPACE;
        sensitive ||= isSensitiveFile(absolute) || Boolean(real && isSensitiveFile(real));
    }
    // `cat .env*` names credential files even when nothing matches.
    sensitive ||= mentions.some((mention) => isSensitiveFile(mention) || isSensitiveFile(mention.replace(/[*?]/g, "")));
    return sensitive ? SENSITIVE_FILE : null;
}
// Absolute paths a command may read. A glob yields the directory it lists and every match,
// so a matched symlink cannot escape the root.
async function* mentionTargets(mentions, base) {
    for (const mention of mentions) {
        const absolute = resolve(base, expandHome(mention));
        if (!/[*?[{]/.test(mention)) {
            yield absolute;
            continue;
        }
        yield resolve(base, expandHome(globBase(mention)));
        try {
            yield* glob(absolute);
        }
        catch { /* The command cannot read an unreadable directory either. */ }
    }
}
// Keep locators (paths, commands) and non-string scalars; everything else may be file content.
function dropContent(input, marker) {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => {
        const locator = locatorKeys.has(key) && (typeof value === "string"
            ? !isPatch(value)
            : Array.isArray(value) && value.every((item) => typeof item === "string"));
        const scalar = value === null || ["number", "boolean"].includes(typeof value);
        return [key, locator || scalar ? value : marker];
    }));
}
// Shell arguments that may name files, skipping each command's program name and `VAR=` prefixes.
function commandArguments(command) {
    return shellCommands(command).flatMap((words) => pathWords(words.slice(words.findIndex((word) => !/^\w+=/.test(word)) + 1)));
}
// Arguments that look like paths; `--flag=path` is checked by its value.
function pathWords(words) {
    return words.flatMap((token) => {
        const word = token.startsWith("-") ? token.slice(token.indexOf("=") + 1 || token.length) : token;
        return word && !word.includes("://") && (/^[~./]/.test(word) || word.includes("/") || isSensitiveFile(word)) ? [word] : [];
    });
}
// Split a script into simple commands of words, honoring quotes and backslash escapes.
// The target of an output redirection is a write, not a read, and is dropped.
function shellCommands(script) {
    const commands = [[]];
    let word = null;
    let redirected = false;
    const endWord = () => {
        if (word !== null && !redirected)
            commands.at(-1).push(word);
        if (word !== null)
            redirected = false;
        word = null;
    };
    for (let index = 0; index < script.length; index++) {
        const char = script[index];
        if (char === "\\")
            word = (word ?? "") + (script[++index] ?? "");
        else if (char === "'" || char === '"') {
            word ??= "";
            for (index++; index < script.length && script[index] !== char; index++) {
                if (char === '"' && script[index] === "\\")
                    index++;
                word += script[index] ?? "";
            }
        }
        else if (char === ">") {
            if (word !== null && /^\d+$/.test(word))
                word = null; // `2>`: a descriptor, not an argument
            endWord();
            redirected = true;
        }
        else if ("|;&()`\n".includes(char)) {
            endWord();
            redirected = false;
            commands.push([]);
        }
        else if (char === "<" || /\s/.test(char))
            endWord();
        else
            word = (word ?? "") + char;
    }
    endWord();
    return commands;
}
export function isPatch(text) {
    return text.includes("*** Begin Patch");
}
function patchPaths(patch) {
    return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1].trim());
}
function isSensitiveFile(path) {
    return sensitiveFile.test(sep === "/" ? path : path.replaceAll(sep, "/"));
}
function expandHome(path) {
    const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(path);
    return home ? join(homedir(), path.slice(home[0].length)) : path;
}
// `~/.ssh/*` is checked as `~/.ssh/`.
function globBase(path) {
    const glob = path.search(/[*?[{]/);
    return glob === -1 ? path : path.slice(0, path.lastIndexOf("/", glob) + 1) || ".";
}
// Resolve symlinks through the deepest existing ancestor, so a new file resolves like its directory.
export async function resolveReal(path) {
    const rest = [];
    let current = path;
    while (true) {
        try {
            return join(await realpath(current), ...rest);
        }
        catch {
            const parent = dirname(current);
            if (parent === current)
                return path;
            rest.unshift(basename(current));
            current = parent;
        }
    }
}
