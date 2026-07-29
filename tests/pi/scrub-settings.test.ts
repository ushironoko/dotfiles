import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRUBBER = resolve(import.meta.dir, "../../pi/scrub-settings.ts");
const MANAGED_SKILL_EXCLUSION = "!/Users/ushironoko/.agents/skills/**";

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

describe("Pi settings scrubber", () => {
  test("keeps portable settings and the managed skill exclusion", async () => {
    const input = `${JSON.stringify(
      {
        theme: "transparent-dark",
        defaultProvider: "openai-codex",
        skills: [MANAGED_SKILL_EXCLUSION, "relative-skill"],
      },
      null,
      2,
    )}\n`;

    const result = await scrub(input);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(input);
  });

  test("drops runtime state, credentials, and unmanaged absolute paths", async () => {
    const input = `${JSON.stringify(
      {
        lastChangelogVersion: "0.80.7",
        trackingId: "machine-account-id",
        httpProxy: "https://user:password@proxy.example",
        theme: "transparent-dark",
        sessionDir: "/Users/example/private-client/sessions",
        skills: [
          MANAGED_SKILL_EXCLUSION,
          "/Users/example/private-client/skills",
          "relative-skill",
        ],
        provider: {
          apiKey: "secret-api-key",
          nested: {
            accessToken: "secret-access-token",
            transport: "sse",
          },
        },
        endpoint: "https://user:password@example.test/api",
      },
      null,
      2,
    )}\n`;

    const result = await scrub(input);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed).toEqual({
      theme: "transparent-dark",
      skills: [MANAGED_SKILL_EXCLUSION, "relative-skill"],
      provider: { nested: { transport: "sse" } },
    });
    expect(result.stdout).not.toContain("private-client");
    expect(result.stdout).not.toContain("password");
    expect(result.stdout).not.toContain("secret-api-key");
  });

  test("is idempotent after sensitive values are removed", async () => {
    const input = `${JSON.stringify(
      {
        lastChangelogVersion: "0.80.7",
        theme: "transparent-dark",
        skills: [MANAGED_SKILL_EXCLUSION],
      },
      null,
      2,
    )}\n`;

    const first = await scrub(input);
    const second = await scrub(first.stdout);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  test("fails loudly on invalid JSON", async () => {
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
