import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRUBBER = resolve(import.meta.dir, "../../claude/scrub-settings.ts");

interface ScrubResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const scrub = async (input: string): Promise<ScrubResult> => {
  const proc = Bun.spawn(["bun", SCRUBBER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("claude settings scrubber", () => {
  test("drops the top-level remote key and keeps everything else", async () => {
    const input = `${JSON.stringify(
      {
        permissions: { allow: ["Bash(pnpm:*)"] },
        autoCompactEnabled: true,
        remote: { defaultEnvironmentId: "env_local_machine_state" },
      },
      null,
      2,
    )}\n`;

    const result = await scrub(input);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("remote");
    expect(result.stdout).not.toContain("env_local_machine_state");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.permissions).toEqual({ allow: ["Bash(pnpm:*)"] });
    expect(parsed.autoCompactEnabled).toBe(true);
  });

  test("is byte-identical for content without a remote key (idempotent)", async () => {
    const input = `${JSON.stringify(
      { permissions: { deny: [] }, statusLine: { type: "command" } },
      null,
      2,
    )}\n`;

    const first = await scrub(input);
    const second = await scrub(first.stdout);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(input);
    expect(second.stdout).toBe(first.stdout);
  });

  test("preserves key order of the remaining keys", async () => {
    const input = `${JSON.stringify(
      { b: 1, remote: { defaultEnvironmentId: "x" }, a: 2 },
      null,
      2,
    )}\n`;

    const result = await scrub(input);

    expect(result.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["b", "a"]);
  });

  test("fails loudly on invalid JSON so required=true aborts the git operation", async () => {
    const result = await scrub("{ not json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  });

  test("fails loudly on a non-object top level", async () => {
    const result = await scrub('["array"]');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be a JSON object");
  });
});
