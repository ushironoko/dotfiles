import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiCompatibilityResult } from "../../scripts/pi-compat/index";
import type { PiInstallation } from "../../scripts/pi-compat/installation";
import type { CommandResult } from "../../scripts/pi-compat/process";
import {
  acquireUpdateLock,
  updatePiSafely,
} from "../../scripts/pi-compat/update-state";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const installation = (version: string): PiInstallation => ({
  bunExecutable: "/tools/bun",
  globalBin: "/global/bin",
  binaryPath: "/global/bin/pi",
  binaryRealPath: "/global/node_modules/pi/dist/cli.js",
  packageRoot: "/global/node_modules/pi",
  packageName: "@earendil-works/pi-coding-agent",
  packageVersion: version,
  corePackages: {
    "@earendil-works/pi-coding-agent": {
      root: "/global/node_modules/pi",
      version,
      manifest: {},
    },
  },
});

const compatible = (value: PiInstallation): PiCompatibilityResult => ({
  baseline: { ok: true, issues: [], packages: [] },
  installation: value,
});

const result = (exitCode = 0, stderr = ""): CommandResult => ({
  argv: [],
  exitCode,
  stdout: "",
  stderr,
  timedOut: false,
  truncated: false,
});

const paths = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-update-test-"));
  roots.push(root);
  return {
    lockPath: join(root, "update.lock"),
    journalPath: join(root, "recovery.json"),
  };
};

describe("safe pi updater", () => {
  test("aborts before mutation when preflight is not known-good", async () => {
    const temp = await paths();
    let runs = 0;
    await expect(
      updatePiSafely({
        ...temp,
        checkCompatibility: async () => {
          throw new Error("preflight failed");
        },
        discover: async () => installation("0.80.7"),
        run: async () => {
          runs += 1;
          return result();
        },
      }),
    ).rejects.toThrow("preflight failed");
    expect(runs).toBe(0);
  });

  test("accepts an updated candidate after compatibility verification", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      run: async (argv) => {
        calls.push(argv.includes("update") ? "update" : "rollback");
        current = installation("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: true,
      updated: true,
      rolledBack: false,
      previousVersion: "0.80.7",
      currentVersion: "0.81.0",
    });
    expect(calls).toEqual(["update"]);
  });

  test("does not reinstall when update fails without changing installation", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      run: async (argv) => {
        calls.push(argv.includes("update") ? "update" : "rollback");
        return result(1, "updater failed");
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("without changing");
    expect(calls).toEqual(["update"]);
  });

  test("rolls back a nonzero update when metadata is unchanged but verification fails", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    let broken = false;
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (broken) throw new Error("package files are incomplete");
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        if (argv.includes("update")) {
          calls.push("update");
          broken = true;
          return result(1, "partial update");
        }
        calls.push("rollback");
        broken = false;
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: true });
    expect(calls).toEqual(["update", "rollback"]);
  });

  test("automatically restores and verifies an incompatible candidate", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0") {
          throw new Error("candidate incompatible");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        if (argv.includes("update")) {
          calls.push("update");
          current = installation("0.81.0");
        } else {
          calls.push("rollback");
          current = installation("0.80.7");
        }
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: false,
      rolledBack: true,
      currentVersion: "0.80.7",
    });
    expect(calls).toEqual(["update", "rollback"]);
  });

  test("preserves a manual recovery journal when rollback fails", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion !== "0.80.7")
          throw new Error("bad candidate");
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        if (argv.includes("update")) {
          current = installation("0.81.0");
          return result();
        }
        return result(1, "registry unavailable");
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.manualRecoveryArgv?.join(" ")).toContain("0.80.7");
    const journal = await readFile(temp.journalPath, "utf8");
    expect(journal).toContain("pi-harness/update-recovery");
  });

  test("clears an unfinished journal when restoration already completed", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let calls = 0;
    const dependencies = {
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion !== "0.80.7")
          throw new Error("bad candidate");
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv: string[]) => {
        calls += 1;
        if (argv.includes("update")) {
          current = installation("0.81.0");
          return result();
        }
        return result(1, "rollback process was interrupted after install");
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv).toBeDefined();
    current = installation("0.80.7");
    const callsBeforeRecovery = calls;
    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(recovered.message).toContain("already-restored");
    expect(calls).toBe(callsBeforeRecovery);
  });

  test("recovers an unfinished journal before attempting another update", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let rollbackAvailable = false;
    const dependencies = {
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion !== "0.80.7")
          throw new Error("bad candidate");
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv: string[]) => {
        if (argv.includes("update")) {
          current = installation("0.81.0");
          return result();
        }
        if (!rollbackAvailable) return result(1, "temporary registry failure");
        current = installation("0.80.7");
        return result();
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv).toBeDefined();
    rollbackAvailable = true;
    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(current.packageVersion).toBe("0.80.7");
  });

  test("rejects a concurrent lock and reclaims a stale lock", async () => {
    const temp = await paths();
    const lock = await acquireUpdateLock(temp.lockPath, process.pid);
    await expect(acquireUpdateLock(temp.lockPath, process.pid)).rejects.toThrow(
      "another pi update",
    );
    await lock.release();

    await writeFile(temp.lockPath, "999999999\n");
    const stale = await acquireUpdateLock(temp.lockPath, process.pid);
    await stale.release();
  });
});
