import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupAsukuNotify from "../../pi/extensions/pi-harness/features/asuku-notify/index";
import type { DetachedSpawnFunction } from "../../pi/extensions/pi-harness/lib/detached";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const tempDirectories: string[] = [];

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await setupTestDirectory(prefix);
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
};

/** Executable stub standing in for asuku-hook: captures argv + stdin. */
const writeStubBinary = async (
  directory: string,
  captureFile: string,
): Promise<string> => {
  const binary = join(directory, "asuku-hook");
  // Write argv + stdin to a temp file, then rename: pollers must never
  // observe a half-written capture.
  await fs.writeFile(
    binary,
    [
      "#!/bin/bash",
      `{ printf '%s\\n' "$1"; cat; } > "${captureFile}.tmp"`,
      `mv "${captureFile}.tmp" "${captureFile}"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return binary;
};

describe("pi-harness asuku-notify", () => {
  test("agent_settled feeds a detached notification with the session payload", async () => {
    const home = await makeTempDirectory("pi-asuku-home");
    const captureFile = join(home, "captured.txt");
    const binary = await writeStubBinary(home, captureFile);
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), { binaryPath: binary });

    await pi.emitAgentSettled();
    await waitFor(async () => {
      try {
        await fs.access(captureFile);
        return true;
      } catch {
        return false;
      }
    });

    const captured = await fs.readFile(captureFile, "utf8");
    const [argLine, ...payloadLines] = captured.split("\n");
    expect(argLine).toBe("notification");
    const payload = JSON.parse(payloadLines.join("\n"));
    expect(payload.hook_event_name).toBe("Notification");
    expect(payload.session_id).toBe("pi-harness");
    expect(payload.cwd).toBe(home);
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
  });

  test("a missing binary is silently skipped without launching anything", async () => {
    const home = await makeTempDirectory("pi-asuku-missing");
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: join(home, "does-not-exist"),
      spawnDetached,
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
  });

  test("a non-executable binary is silently skipped", async () => {
    const home = await makeTempDirectory("pi-asuku-noexec");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o644 });
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      spawnDetached,
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
  });
});
