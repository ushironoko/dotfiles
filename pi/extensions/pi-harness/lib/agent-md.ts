/**
 * Parser for Claude Code agent definitions (~/.claude/agents/*.md).
 *
 * Frontmatter is a single-level "key: value" block delimited by "---" lines;
 * the rest of the file is the agent's system prompt. Only name/description
 * are required (the repo's agent files carry no model/tools keys; pi defaults
 * apply when absent).
 */

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

function splitFrontmatter(markdown: string): Frontmatter | undefined {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return undefined;

  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "") fields[key] = value;
  }

  const bodyStart = normalized.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1);
  return { fields, body };
}

export function parseAgentMarkdown(
  markdown: string,
): AgentDefinition | undefined {
  const frontmatter = splitFrontmatter(markdown);
  if (frontmatter === undefined) return undefined;

  const { fields, body } = frontmatter;
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (name === "" || description === "") return undefined;

  const definition: AgentDefinition = {
    name,
    description,
    systemPrompt: body.trim(),
  };
  if (fields.tools !== undefined && fields.tools !== "") {
    definition.tools = fields.tools
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool !== "");
  }
  if (fields.model !== undefined && fields.model !== "") {
    definition.model = fields.model;
  }
  return definition;
}
