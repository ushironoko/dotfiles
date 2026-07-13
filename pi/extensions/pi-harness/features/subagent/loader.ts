import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentMarkdown, type AgentDefinition } from "../../lib/agent-md";
import { capText } from "./spawn";

const loadAgents = (dir: string): AgentDefinition[] => {
  if (!existsSync(dir)) return [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    try {
      const agent = parseAgentMarkdown(
        readFileSync(join(dir, entry.name), "utf8"),
      );
      if (agent !== undefined) agents.push(agent);
    } catch {
      // Ignore unreadable or malformed agent files during discovery.
    }
  }
  return agents;
};

// Shared agent lookup for both the subagent and workflow features (previously
// duplicated as findAgent/resolveAgent). Throws with the available names when
// the requested agent is unknown.
const findAgent = (
  agents: AgentDefinition[],
  name: string,
): AgentDefinition => {
  const agent = agents.find((candidate) => candidate.name === name);
  if (agent !== undefined) return agent;
  const available = agents.map((candidate) => candidate.name).join(", ");
  throw new Error(
    capText(
      `Unknown agent: "${name}". Available agents: ${available || "none"}.`,
    ),
  );
};

export { findAgent, loadAgents };
