import { claudeCode } from "./claude-code/index.js";
import { cursor } from "./cursor/index.js";
import { codex } from "./codex/index.js";
// The capture client's coding-agent registry: one typed adapter per agent, in
// the order of schemas/coding-agents/coding-agents.json (a unit test keeps the
// two in sync). This is the only place outside src/agents/<agent>/ that names
// an agent. Adding an agent means adding its adapter here; see CODING_AGENTS.md.
export const agents = [codex, claudeCode, cursor];
/** The adapter a hook command names (`node dist/hook.js <id>`), or undefined. */
export function agentById(id) {
    return agents.find((agent) => agent.id === id);
}
/** The display name of a coding-agent producer, for candidate-facing messages. */
export function displayName(producer) {
    return agents.find((agent) => agent.producer === producer)?.displayName ?? producer;
}
/** Every agent's connect command, for candidate-facing pairing help. */
export function connectCommands() {
    const commands = agents.map((agent) => `${agent.connectCommand} <code> in ${agent.displayName}`);
    return commands.length < 2 ? commands.join("") : `${commands.slice(0, -1).join(", ")} or ${commands.at(-1)}`;
}
