import { describe, expect, test } from "bun:test";
import {
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandOptions,
} from "../../pi/extensions/pi-harness/lib/bounded-process";

const options = (
  overrides: Partial<BoundedCommandOptions> = {},
): BoundedCommandOptions => ({
  cwd: process.cwd(),
  env: { ...process.env } as Record<string, string>,
  timeoutMs: 1_000,
  stdoutMaxBytes: 1_024,
  stderrMaxBytes: 1_024,
  ...overrides,
});

describe("bounded process stdin", () => {
  test("passes exact multiline bytes without shell interpretation", async () => {
    const input = "line one\n$(printf injected)\n`touch nope`\n";
    const result = await runBoundedCommand(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      options({ stdin: input, stdinMaxBytes: Buffer.byteLength(input) }),
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString("utf8")).toBe(input);
  });

  test("requires an explicit stdin cap and never includes body bytes in errors", async () => {
    const secret = "credential-like-private-body";
    await expect(
      runBoundedCommand(
        process.execPath,
        ["-e", "process.stdin.resume()"],
        options({ stdin: secret }),
      ),
    ).rejects.toEqual(expect.any(BoundedCommandError));

    try {
      await runBoundedCommand(
        process.execPath,
        ["-e", "process.stdin.resume()"],
        options({ stdin: secret, stdinMaxBytes: 4 }),
      );
      throw new Error("expected oversize rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedCommandError);
      expect((error as Error).message).not.toContain(secret);
      expect(error).toMatchObject({ kind: "oversize" });
    }
  });
});
