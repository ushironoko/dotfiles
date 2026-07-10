import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRUBBER = resolve(import.meta.dir, "../../codex/scrub-config.awk");

const scrub = async (input: string): Promise<string> => {
  const proc = Bun.spawn(["awk", "-f", SCRUBBER], {
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
  if (exitCode !== 0) {
    throw new Error(`scrub-config.awk failed: ${stderr.trim()}`);
  }
  return stdout;
};

describe("codex config scrubber", () => {
  test("drops the complete hooks.state tree while retaining portable hooks config", async () => {
    const input = `model = "gpt-5.6-sol"

[hooks]
enabled = true

[hooks.state]

[hooks.state."relative-hook-id"]
trusted_hash = "sha256:machine-local"

[features]
hooks = true
`;

    const output = await scrub(input);

    expect(output).not.toContain("[hooks.state");
    expect(output).not.toContain("trusted_hash");
    expect(output).toContain("[hooks]\nenabled = true");
    expect(output).toContain("[features]\nhooks = true");
  });

  test("is idempotent after removing machine-local tables", async () => {
    const input = `model = "gpt-5.6-sol"

[projects."/private/repository"]
trust_level = "trusted"

[hooks.state]

[hooks.state."/Users/example/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:machine-local"

[agents]
max_threads = 12
`;

    const once = await scrub(input);
    const twice = await scrub(once);

    expect(twice).toBe(once);
    expect(once).toContain("[agents]\nmax_threads = 12");
    expect(once).not.toContain("/private/repository");
    expect(once).not.toContain("[hooks.state");
  });
});
