import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { shellCommands } from "./scope.js";
/** Identify executable test commands, respecting shell quoting rather than matching argument text. */
export function testRunner(command) {
    for (const words of shellCommands(command)) {
        let index = 0;
        while (words[index] && /^\w+=/.test(words[index]))
            index++;
        const program = basename(words[index] ?? "");
        const args = words.slice(index + 1);
        if (["pytest", "vitest", "jest", "mocha", "rspec", "phpunit"].includes(program))
            return program;
        if (/^python[0-9.]{0,8}$/.test(program) && args[0] === "-m" && args[1] === "pytest")
            return "pytest";
        if (program === "uv" && args[0] === "run" && args[1] === "pytest")
            return "pytest";
        if (["go", "cargo"].includes(program) && args[0] === "test")
            return `${program} test`;
        if (["npm", "pnpm", "yarn", "bun"].includes(program) && (args[0] === "test" || args[0] === "run" && args[1] === "test"))
            return program;
        if (["npx", "pnpm", "yarn", "bun"].includes(program)) {
            const executable = args[0] === "exec" ? args[1] : args[0];
            if (executable && ["vitest", "jest", "mocha", "pytest", "rspec", "phpunit"].includes(executable))
                return executable;
        }
    }
    return undefined;
}
/** Parse only recognizable summary lines already supplied by a hook, in linear time. */
export function testCounts(output) {
    const counts = {};
    for (const line of stripVTControlCharacters(output.slice(0, 64 * 1024)).split("\n")) {
        if (/^\s*(?:=|Tests\b|Test Files\b|Test Suites\b|\d{1,15} (?:passed|failed|passing|failing|pending|skipped)|test result:|\d{1,15} examples|OK \(|FAILURES!|Tests:)/.test(line)) {
            if (/^\s*(?:Test Files|Test Suites)\b/.test(line))
                continue;
            for (const match of line.matchAll(/\b(\d{1,15})\s+(passed|failed|skipped|passing|failing|pending|ignored|failures)\b/g)) {
                const key = { passed: "passed", passing: "passed", failed: "failed", failing: "failed", failures: "failed", skipped: "skipped", pending: "skipped", ignored: "skipped" }[match[2]];
                const value = Number(match[1]);
                if (Number.isSafeInteger(value))
                    counts[key] = value;
            }
            const rspec = /\b(\d{1,15}) examples, (\d{1,15}) failures/.exec(line);
            if (rspec) {
                counts.failed = Number(rspec[2]);
                const passed = Number(rspec[1]) - counts.failed - (counts.skipped ?? 0);
                if (passed >= 0)
                    counts.passed = passed;
            }
        }
    }
    return counts;
}
