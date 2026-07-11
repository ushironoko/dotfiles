import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentMarkdown, type AgentDefinition } from "../../lib/agent-md";

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

export { loadAgents };
