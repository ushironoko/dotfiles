#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SandboxMode = "read-only" | "workspace-write";

interface AgentSpec {
  name: string;
  sandboxMode: SandboxMode;
  nativeDescription?: string;
  nativeInstructions?: string;
}

interface ParsedClaudeAgent {
  name: string;
  description: string;
  body: string;
}

interface GeneratedAgent {
  name: string;
  path: string;
  content: string;
  expected: {
    description: string;
    developerInstructions: string;
    sandboxMode: SandboxMode;
  };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_AGENTS_DIR = join(REPO_ROOT, "claude", ".claude", "agents");
const CODEX_AGENTS_DIR = join(REPO_ROOT, "codex", "agents");

const CODEX_REVIEWER_INSTRUCTIONS = `You are the Codex-native read-only reviewer role.

Review the artifact assigned by the parent agent: code, an uncommitted diff, a commit, a plan, a design, or reported findings. Use repository evidence and available read-only tools directly. Do not invoke another Codex CLI process and do not delegate the review to a nested agent.

Rules:

- Never edit, create, delete, stage, commit, merge, or push files.
- Inspect the relevant source, tests, configuration, and diff before reaching conclusions.
- Prioritize correctness bugs, regressions, security or data-loss risks, missing tests, and broken invariants over style preferences.
- Give every actionable finding a severity, precise location when available, evidence, and a concrete remediation.
- Do not invent findings. Say explicitly when evidence is insufficient.
- If no actionable findings remain, say so and note any residual verification gap.
- Return the review to the parent agent; do not implement fixes.
`;

const CODEX_POC_INSTRUCTIONS = `You are the Codex-native isolated implementation PoC role.

Implement the assigned competing proof of concept directly with the available tools. Do not invoke another Codex CLI process and do not delegate implementation to a nested agent.

Before any write, establish the target from an explicit absolute worktree path in the task, or otherwise from the current working directory. Resolve its git toplevel, git directory, and common git directory. Proceed only when the target is an isolated linked git worktree. A main repository checkout, a non-git directory, an ambiguous target, or a target outside the explicitly assigned worktree must be refused without making changes.

Rules:

- Record the pre-existing git status before editing and preserve unrelated changes.
- Touch only the files and paths explicitly assigned by the parent agent.
- Keep every write inside the validated isolated worktree.
- Never widen the writable boundary, stage, commit, merge, push, or apply the PoC to another checkout.
- Implement the requested approach, run proportionate verification, and leave the diff uncommitted for comparison.
- On failure, report the blocker plus any partial changes; never describe an incomplete run as having no changes.
- Return the worktree path, implementation summary, verification results, and git status/diff summary to the parent agent.
`;

const CODEX_RUNNER_INSTRUCTIONS = `You are the Codex-native write-capable runner role.

Perform the assigned implementation task directly with the available tools in the directory selected by the parent agent. Do not invoke another Codex CLI process and do not delegate implementation to a nested agent.

The task must state a concrete write scope: exact files, paths, or a directory boundary. If the scope is missing, ambiguous, overlaps another worker's assignment, or would require writing outside the selected directory, stop before editing and report the problem.

Rules:

- Confirm the target is inside a git work tree and record the pre-existing git status.
- Touch only the explicitly assigned paths; parallel-write collision avoidance is part of your contract.
- Preserve unrelated and pre-existing changes.
- Never widen the writable boundary, stage, commit, merge, push, or use destructive git recovery commands.
- Implement the task, run proportionate verification, and leave all changes uncommitted for parent review.
- On failure, report the blocker plus any partial changes; never describe an incomplete run as having no changes.
- Return the target directory, implementation summary, verification results, and git status/diff summary to the parent agent.
`;

const AGENTS: readonly AgentSpec[] = [
  { name: "comment-reviewer", sandboxMode: "read-only" },
  { name: "rust-reviewer", sandboxMode: "read-only" },
  // The source agent measures first and only writes after explicit user
  // approval, so it needs a write-capable role for its refactoring phase.
  { name: "similarity", sandboxMode: "workspace-write" },
  { name: "tdd-reviewer", sandboxMode: "read-only" },
  {
    name: "codex-reviewer",
    sandboxMode: "read-only",
    nativeDescription:
      "Codex-native read-only reviewer for plans, designs, diffs, code, and findings. Reports evidence-backed issues without editing files or spawning a nested Codex CLI.",
    nativeInstructions: CODEX_REVIEWER_INSTRUCTIONS,
  },
  {
    name: "codex-poc",
    sandboxMode: "workspace-write",
    nativeDescription:
      "Codex-native implementation PoC that writes only inside an explicitly assigned isolated linked git worktree and leaves the diff uncommitted.",
    nativeInstructions: CODEX_POC_INSTRUCTIONS,
  },
  {
    name: "codex-runner",
    sandboxMode: "workspace-write",
    nativeDescription:
      "Codex-native write-capable worker constrained to an explicit non-overlapping path scope selected by the parent agent.",
    nativeInstructions: CODEX_RUNNER_INSTRUCTIONS,
  },
];

const parseFrontmatterValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseClaudeAgent = (
  source: string,
  sourcePath: string,
): ParsedClaudeAgent => {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${sourcePath}: missing opening frontmatter delimiter`);
  }

  const closingDelimiter = normalized.indexOf("\n---\n", 4);
  if (closingDelimiter === -1) {
    throw new Error(`${sourcePath}: missing closing frontmatter delimiter`);
  }

  const frontmatter = normalized.slice(4, closingDelimiter);
  const bodyWithSeparator = normalized.slice(closingDelimiter + 5);
  const body = bodyWithSeparator.startsWith("\n")
    ? bodyWithSeparator.slice(1)
    : bodyWithSeparator;
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descriptionMatch) {
    throw new Error(
      `${sourcePath}: frontmatter must contain name and description`,
    );
  }

  return {
    name: parseFrontmatterValue(nameMatch[1]),
    description: parseFrontmatterValue(descriptionMatch[1]),
    body,
  };
};

const serializeMultilineLiteral = (value: string, label: string): string => {
  if (value.includes("'''")) {
    throw new Error(
      `${label}: cannot encode three consecutive single quotes in TOML`,
    );
  }
  return `'''${value}'''`;
};

const renderAgent = (
  spec: AgentSpec,
  source: ParsedClaudeAgent,
): GeneratedAgent => {
  if (source.name !== spec.name) {
    throw new Error(
      `${spec.name}: source frontmatter name is ${JSON.stringify(source.name)}`,
    );
  }

  const description = spec.nativeDescription ?? source.description;
  const developerInstructions = spec.nativeInstructions ?? source.body;
  const sourceRelativePath = `claude/.claude/agents/${spec.name}.md`;
  const adaptation = spec.nativeInstructions
    ? "Codex-native semantic adaptation; the compatibility name is preserved."
    : "Claude agent body is preserved as developer instructions.";
  const content = [
    `# Generated by scripts/sync-codex-agents.ts from ${sourceRelativePath}.`,
    "# Do not edit by hand; rerun the generator instead.",
    `# ${adaptation}`,
    "",
    `name = ${JSON.stringify(spec.name)}`,
    `description = ${JSON.stringify(description)}`,
    `sandbox_mode = ${JSON.stringify(spec.sandboxMode)}`,
    `developer_instructions = ${serializeMultilineLiteral(developerInstructions, spec.name)}`,
    "",
  ].join("\n");

  return {
    name: spec.name,
    path: join(CODEX_AGENTS_DIR, `${spec.name}.toml`),
    content,
    expected: {
      description,
      developerInstructions,
      sandboxMode: spec.sandboxMode,
    },
  };
};

const validateGeneratedAgent = (agent: GeneratedAgent): void => {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(agent.content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${agent.name}: generated TOML is invalid`, {
      cause: error,
    });
  }

  const expectedFields: Record<string, string> = {
    name: agent.name,
    description: agent.expected.description,
    sandbox_mode: agent.expected.sandboxMode,
    developer_instructions: agent.expected.developerInstructions,
  };

  for (const [field, expected] of Object.entries(expectedFields)) {
    if (parsed[field] !== expected) {
      throw new Error(
        `${agent.name}: generated ${field} did not survive TOML parsing`,
      );
    }
  }
};

const readIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const loadGeneratedAgents = async (): Promise<GeneratedAgent[]> =>
  Promise.all(
    AGENTS.map(async (spec) => {
      const sourcePath = join(CLAUDE_AGENTS_DIR, `${spec.name}.md`);
      const source = parseClaudeAgent(
        await readFile(sourcePath, "utf8"),
        sourcePath,
      );
      const generated = renderAgent(spec, source);
      validateGeneratedAgent(generated);
      return generated;
    }),
  );

const checkGeneratedAgents = async (
  agents: GeneratedAgent[],
): Promise<void> => {
  const drifted: string[] = [];

  for (const agent of agents) {
    const current = await readIfExists(agent.path);
    if (current !== agent.content) {
      drifted.push(agent.path.slice(REPO_ROOT.length + 1));
    }
  }

  if (drifted.length > 0) {
    console.error("Codex agent definitions are out of sync:");
    for (const path of drifted) {
      console.error(`  ${path}`);
    }
    console.error("Run: bun scripts/sync-codex-agents.ts");
    process.exitCode = 1;
    return;
  }

  console.log(`Codex agent definitions are in sync (${agents.length} files).`);
};

const writeGeneratedAgents = async (
  agents: GeneratedAgent[],
): Promise<void> => {
  await mkdir(CODEX_AGENTS_DIR, { recursive: true });
  let changed = 0;

  for (const agent of agents) {
    const current = await readIfExists(agent.path);
    if (current === agent.content) {
      continue;
    }
    await writeFile(agent.path, agent.content, "utf8");
    changed += 1;
  }

  console.log(
    `Synchronized ${agents.length} Codex agent definitions (${changed} changed).`,
  );
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    console.error("Usage: bun scripts/sync-codex-agents.ts [--check]");
    process.exitCode = 2;
    return;
  }

  const agents = await loadGeneratedAgents();
  if (args[0] === "--check") {
    await checkGeneratedAgents(agents);
    return;
  }
  await writeGeneratedAgents(agents);
};

await main();
