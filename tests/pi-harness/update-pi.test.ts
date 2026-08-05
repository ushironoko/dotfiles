import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiCompatibilityResult } from "../../scripts/pi-compat/index";
import type { PiInstallation } from "../../scripts/pi-compat/installation";
import type { CommandResult } from "../../scripts/pi-compat/process";
import {
  acquireUpdateLock,
  allowsUnsupportedPatchGeneration,
  assertNoPendingUpdateRecovery,
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

const installationWithTui = (
  version: string,
  tuiVersion: string,
): PiInstallation => {
  const value = installation(version);
  return {
    ...value,
    corePackages: {
      ...value.corePackages,
      "@earendil-works/pi-tui": {
        root: "/global/node_modules/pi-tui",
        version: tuiVersion,
        manifest: {},
      },
    },
  };
};

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

const toLegacyJournal = (source: string): string =>
  source
    .replace('    "--force",\n', "")
    .replace(
      /\n  "rollbackPackages": \[[\s\S]*?\],(?=\n  "restorePatches")/,
      "",
    )
    .replace(/,\n  "restorePatches": (?:true|false)(?=\n})/, "");

describe("safe pi updater", () => {
  test("allows unsupported generations only before candidate mutation", () => {
    expect(allowsUnsupportedPatchGeneration("preflight")).toBe(true);
    expect(allowsUnsupportedPatchGeneration("candidate")).toBe(false);
    expect(allowsUnsupportedPatchGeneration("rollback")).toBe(false);
    expect(allowsUnsupportedPatchGeneration("recovery")).toBe(false);
    expect(allowsUnsupportedPatchGeneration("unchanged")).toBe(true);
  });

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

  test("preserves an already-patched source across an initial-journal interruption", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    const phases: string[] = [];
    let runs = 0;
    const dependencies = {
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      inspectPatches: async () => true,
      applyPatches: async (_candidate: PiInstallation, phase: string) => {
        phases.push(phase);
        if (phase === "preflight") {
          throw new Error("interrupted before preflight journal rewrite");
        }
        return true;
      },
      run: async () => {
        runs += 1;
        return result(1, "rollback interrupted");
      },
    };

    const interrupted = await updatePiSafely(dependencies);
    expect(interrupted.manualRecoveryArgv).toBeDefined();
    const recovered = await updatePiSafely(dependencies);

    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(recovered.message).toContain("already-restored");
    expect(phases).toEqual(["preflight", "recovery"]);
    expect(runs).toBe(1);
  });

  test("restores pristine packages when patched preflight verification fails", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    let patched = false;
    const calls: string[] = [];
    const phases: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (patched) throw new Error("patched preflight is incompatible");
        return compatible(current);
      },
      discover: async () => current,
      applyPatches: async (_candidate, phase) => {
        phases.push(phase);
        if (phase === "preflight") patched = true;
        return true;
      },
      run: async (argv) => {
        calls.push(argv.includes("update") ? "update" : "rollback");
        patched = false;
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: true });
    expect(calls).toEqual(["rollback"]);
    expect(phases).toEqual(["preflight"]);
    expect(patched).toBe(false);
    await expect(readFile(temp.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("reinstalls an interrupted partial preflight patch cohort", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    const packageState: { value: "pristine" | "partial" } = {
      value: "pristine",
    };
    let rejectPartial = true;
    let rollbackAvailable = false;
    const calls: string[] = [];
    const phases: string[] = [];
    const dependencies = {
      ...temp,
      checkCompatibility: async () => {
        if (packageState.value === "partial" && rejectPartial) {
          throw new Error("preflight patch cohort is partial");
        }
        return compatible(current);
      },
      discover: async () => current,
      applyPatches: async (_candidate: PiInstallation, phase: string) => {
        phases.push(phase);
        if (phase === "preflight") packageState.value = "partial";
        return true;
      },
      run: async () => {
        calls.push("rollback");
        if (!rollbackAvailable) return result(1, "rollback interrupted");
        packageState.value = "pristine";
        return result();
      },
    };

    const interrupted = await updatePiSafely(dependencies);
    expect(interrupted.manualRecoveryArgv).toBeDefined();
    expect(packageState.value).toBe("partial");

    rejectPartial = false;
    rollbackAvailable = true;
    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(packageState.value).toBe("pristine");
    expect(calls).toEqual(["rollback", "rollback"]);
    expect(phases).toEqual(["preflight"]);
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

  test("applies sticky patches before candidate compatibility verification", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const patchedVersions = new Set<string>();
    const patchCalls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (
          current.packageVersion === "0.81.0" &&
          !patchedVersions.has("0.81.0")
        ) {
          throw new Error("candidate was checked before patching");
        }
        return compatible(current);
      },
      discover: async () => current,
      applyPatches: async (candidate) => {
        patchCalls.push(candidate.packageVersion);
        patchedVersions.add(candidate.packageVersion);
        return true;
      },
      run: async () => {
        current = installation("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: true, currentVersion: "0.81.0" });
    expect(patchCalls).toEqual(["0.80.7", "0.81.0"]);
  });

  test("crosses from an unsupported preflight patch generation to a supported candidate", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let candidatePatched = false;
    const phases: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0" && !candidatePatched) {
          throw new Error("new generation was not patched");
        }
        return compatible(current);
      },
      discover: async () => current,
      applyPatches: async (candidate, phase) => {
        phases.push(`${phase}:${candidate.packageVersion}`);
        if (phase === "preflight") return false;
        if (phase === "candidate") candidatePatched = true;
        return true;
      },
      run: async () => {
        current = installation("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: true, currentVersion: "0.81.0" });
    expect(phases).toEqual(["preflight:0.80.7", "candidate:0.81.0"]);
  });

  test("restores an unsupported source without invoking a nonexistent patch", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const phases: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      applyPatches: async (candidate, phase) => {
        phases.push(`${phase}:${candidate.packageVersion}`);
        if (phase === "preflight") return false;
        if (phase === "candidate") throw new Error("unsupported candidate");
        throw new Error("unsupported source patch hook must be skipped");
      },
      run: async (argv) => {
        current = installation(argv.includes("update") ? "0.81.0" : "0.80.7");
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: false,
      rolledBack: true,
      currentVersion: "0.80.7",
    });
    expect(phases).toEqual(["preflight:0.80.7", "candidate:0.81.0"]);
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

  test("reapplies the previous sticky patch after an unsupported candidate rollback", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const patchCalls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      applyPatches: async (candidate) => {
        patchCalls.push(candidate.packageVersion);
        if (candidate.packageVersion === "0.81.0") {
          throw new Error("no sticky patch for candidate");
        }
        return true;
      },
      run: async (argv) => {
        current = installation(argv.includes("update") ? "0.81.0" : "0.80.7");
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: false,
      rolledBack: true,
      currentVersion: "0.80.7",
    });
    expect(patchCalls).toEqual(["0.80.7", "0.81.0", "0.80.7"]);
  });

  test("keeps the journal when a rollback dependency cohort drifts", async () => {
    const temp = await paths();
    let current = installationWithTui("0.80.7", "0.80.7");
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      applyPatches: async (_candidate, phase) => {
        if (phase === "candidate") throw new Error("candidate incompatible");
        return true;
      },
      run: async (argv) => {
        current = argv.includes("update")
          ? installationWithTui("0.81.0", "0.81.0")
          : installationWithTui("0.80.7", "0.80.8");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("package cohort does not match preflight");
    expect(update.manualRecoveryArgv).toContain("--force");
    expect(update.manualRecoveryArgv).toContain(
      "@earendil-works/pi-tui@0.80.7",
    );
    const journal = await readFile(temp.journalPath, "utf8");
    expect(journal).toContain("pi-harness/update-recovery");
    await writeFile(
      temp.journalPath,
      journal.replace(
        "@earendil-works/pi-tui@0.80.7",
        "@earendil-works/pi-tui@0.80.8",
      ),
    );
    await expect(
      assertNoPendingUpdateRecovery(temp.journalPath),
    ).rejects.toThrow("invalid pi update recovery journal");
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
    expect(update.message).toContain("rerun `bun run update:pi`");
    const journal = await readFile(temp.journalPath, "utf8");
    expect(journal).toContain("pi-harness/update-recovery");
    await expect(
      assertNoPendingUpdateRecovery(temp.journalPath),
    ).rejects.toThrow("run `bun run update:pi`");
  });

  test("restores a legacy unsupported-source journal without patching", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let rollbackAvailable = false;
    const phases: string[] = [];
    const dependencies = {
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      applyPatches: async (candidate: PiInstallation, phase: string) => {
        phases.push(`${phase}:${candidate.packageVersion}`);
        if (phase === "preflight") return false;
        if (phase === "candidate") throw new Error("candidate incompatible");
        throw new Error("legacy unsupported source must not invoke patching");
      },
      run: async (argv: string[]) => {
        if (argv.includes("update")) {
          current = installation("0.81.0");
          return result();
        }
        if (!rollbackAvailable) return result(1, "rollback interrupted");
        current = installation("0.80.7");
        return result();
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv).toBeDefined();
    const journal = await readFile(temp.journalPath, "utf8");
    const legacyJournal = toLegacyJournal(journal);
    expect(legacyJournal).not.toBe(journal);
    await writeFile(temp.journalPath, legacyJournal);

    rollbackAvailable = true;
    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(current.packageVersion).toBe("0.80.7");
    expect(phases).toEqual(["preflight:0.80.7", "candidate:0.81.0"]);
  });

  test("clears an already-restored legacy journal without registry access", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let rollbackCalls = 0;
    const phases: string[] = [];
    const dependencies = {
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      applyPatches: async (candidate: PiInstallation, phase: string) => {
        phases.push(`${phase}:${candidate.packageVersion}`);
        if (phase === "preflight") return false;
        if (phase === "candidate") throw new Error("candidate incompatible");
        throw new Error("legacy recovery must not invoke patching");
      },
      run: async (argv: string[]) => {
        if (argv.includes("update")) {
          current = installation("0.81.0");
          return result();
        }
        rollbackCalls += 1;
        return result(1, "registry unavailable");
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv).toBeDefined();
    const journal = await readFile(temp.journalPath, "utf8");
    await writeFile(temp.journalPath, toLegacyJournal(journal));
    current = installation("0.80.7");
    const callsBeforeRecovery = rollbackCalls;

    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(recovered.message).toContain("already-restored");
    expect(rollbackCalls).toBe(callsBeforeRecovery);
    expect(phases).toEqual(["preflight:0.80.7", "candidate:0.81.0"]);
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
      applyPatches: async () => true,
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

  test("never releases a replacement lock owned by another generation", async () => {
    const temp = await paths();
    const lock = await acquireUpdateLock(temp.lockPath, process.pid);
    await rm(temp.lockPath);
    await writeFile(temp.lockPath, `${process.pid}:replacement\n`);

    await expect(lock.release()).rejects.toThrow("ownership changed");
    expect(await readFile(temp.lockPath, "utf8")).toBe(
      `${process.pid}:replacement\n`,
    );
  });

  test("publishes only a complete owner token after staging succeeds", async () => {
    const temp = await paths();
    let publishPath = "";
    let token = "";

    await expect(
      acquireUpdateLock(temp.lockPath, 999_999_997, {
        afterPublishPrepared: ({
          publishPath: preparedPath,
          token: preparedToken,
        }) => {
          publishPath = preparedPath;
          token = preparedToken;
          throw new Error("stop before atomic publication");
        },
      }),
    ).rejects.toThrow("stop before atomic publication");

    await expect(readFile(temp.lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(publishPath, "utf8")).toBe(token);

    const lock = await acquireUpdateLock(temp.lockPath, process.pid);
    await lock.release();
  });

  test("keeps the published lock when staging cleanup follows publication", async () => {
    const temp = await paths();
    let publishPath = "";
    let token = "";

    await expect(
      acquireUpdateLock(temp.lockPath, 999_999_996, {
        afterPublished: ({
          publishPath: preparedPath,
          token: preparedToken,
        }) => {
          publishPath = preparedPath;
          token = preparedToken;
          throw new Error("stop after atomic publication");
        },
      }),
    ).rejects.toThrow("stop after atomic publication");

    expect(await readFile(temp.lockPath, "utf8")).toBe(token);
    await expect(readFile(publishPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const recovered = await acquireUpdateLock(temp.lockPath, process.pid);
    await recovered.release();
  });

  test("coalesces concurrent releases before another generation can acquire", async () => {
    const temp = await paths();
    const lock = await acquireUpdateLock(temp.lockPath, process.pid);

    const firstRelease = lock.release();
    const secondRelease = lock.release();
    expect(firstRelease).toBe(secondRelease);
    await Promise.all([firstRelease, secondRelease]);

    const next = await acquireUpdateLock(temp.lockPath, process.pid);
    await next.release();
  });

  test("reclaims an orphaned stale-lock recovery generation", async () => {
    const temp = await paths();
    const stale = "999999999:stale-main\n";
    await writeFile(temp.lockPath, stale);
    const generation = createHash("sha256")
      .update(stale)
      .digest("hex")
      .slice(0, 16);
    const recoveryPath = `${temp.lockPath}.recovery-${generation}`;
    await writeFile(recoveryPath, "999999998:stale-recovery\n");

    const lock = await acquireUpdateLock(temp.lockPath, process.pid);
    await lock.release();
    await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails closed when stale-lock recovery exceeds its depth limit", async () => {
    const temp = await paths();
    let stalePath = temp.lockPath;
    for (let depth = 0; depth <= 8; depth += 1) {
      const raw = `${999_999_900 + depth}:stale-${depth}\n`;
      await writeFile(stalePath, raw);
      const generation = createHash("sha256")
        .update(raw)
        .digest("hex")
        .slice(0, 16);
      stalePath =
        depth === 0
          ? `${temp.lockPath}.recovery-${generation}`
          : `${temp.lockPath}.recovery-${depth + 1}-${generation}`;
    }

    await expect(
      acquireUpdateLock(temp.lockPath, process.pid),
    ).rejects.toThrow("recovery nesting exceeds the safety limit");
  });

  test("rejects a concurrent lock and reclaims a stale lock", async () => {
    const temp = await paths();
    const lock = await acquireUpdateLock(temp.lockPath, process.pid);
    await expect(acquireUpdateLock(temp.lockPath, process.pid)).rejects.toThrow(
      "another pi update",
    );
    await lock.release();

    await writeFile(temp.lockPath, "999999999\n");
    const contenders = await Promise.allSettled([
      acquireUpdateLock(temp.lockPath, process.pid),
      acquireUpdateLock(temp.lockPath, process.pid),
    ]);
    let acquired = 0;
    for (const contender of contenders) {
      if (contender.status !== "fulfilled") continue;
      acquired += 1;
      await contender.value.release();
    }
    expect(acquired).toBe(1);
  });
});
