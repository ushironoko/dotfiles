#!/usr/bin/env bun

import { resolve } from "node:path";

type ExpectedDecision = "forbidden" | "unmatched";

interface ExecPolicyResult {
  decision?: string;
  matchedRules?: unknown[];
}

const codex = Bun.which("codex");
if (codex === null) {
  console.log("Codex is unavailable; skipping native exec-policy checks.");
  process.exit(0);
}

const rules = resolve(import.meta.dir, "../codex/rules/harness.rules");
const cases: readonly {
  command: string[];
  expected: ExpectedDecision;
}[] = [
  { command: ["bit", "issue", "claim", "12"], expected: "forbidden" },
  {
    command: ["bit", "clone", "relay+ssh://example/repo"],
    expected: "forbidden",
  },
  { command: ["bit", "relay", "sync"], expected: "forbidden" },
  { command: ["bit", "issue", "list", "--open"], expected: "unmatched" },
];

for (const { command, expected } of cases) {
  const proc = Bun.spawn(
    [codex, "execpolicy", "check", "--rules", rules, "--", ...command],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `exec-policy check failed for ${command.join(" ")}: ${stderr.trim()}`,
    );
  }

  const result = JSON.parse(stdout) as ExecPolicyResult;
  const matchedCount = result.matchedRules?.length ?? 0;
  const valid =
    expected === "forbidden"
      ? result.decision === "forbidden" && matchedCount > 0
      : result.decision === undefined && matchedCount === 0;
  if (!valid) {
    throw new Error(
      `Unexpected ${JSON.stringify(result)} for ${command.join(" ")}`,
    );
  }
}

console.log(`Codex exec-policy checks passed (${cases.length} cases).`);
