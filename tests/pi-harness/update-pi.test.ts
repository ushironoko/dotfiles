import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PiCompatibilityResult } from "../../scripts/pi-compat/index";
import type { PiInstallation } from "../../scripts/pi-compat/installation";
import type { CommandResult } from "../../scripts/pi-compat/process";
import {
  acquireUpdateLock,
  assertNoPendingUpdateRecovery,
  updatePiSafely,
  type UpdatePiSnapshotStore,
} from "../../scripts/pi-compat/update-state";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const installation = (version: string): PiInstallation => ({
  bunExecutable: process.execPath,
  globalBin: "/global/bin",
  binaryPath: "/global/bin/pi",
  binaryRealPath:
    "/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  packageRoot: "/global/node_modules/@earendil-works/pi-coding-agent",
  packageName: "@earendil-works/pi-coding-agent",
  packageVersion: version,
  corePackages: {
    "@earendil-works/pi-coding-agent": {
      root: "/global/node_modules/@earendil-works/pi-coding-agent",
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
        root: "/global/node_modules/@earendil-works/pi-tui",
        version: tuiVersion,
        manifest: {},
      },
    },
  };
};

const compatible = (
  value: PiInstallation,
  targetVersion = "0.81.0",
): PiCompatibilityResult => ({
  baseline: {
    ok: true,
    issues: [],
    packages: [
      {
        name: "@earendil-works/pi-coding-agent",
        lockedVersion: targetVersion,
        installedVersion: targetVersion,
        installedRoot: "/local/node_modules/pi",
      },
    ],
  },
  installation: value,
});

const isCandidateInstall = (argv: string[]): boolean =>
  argv.includes("@earendil-works/pi-coding-agent@0.81.0") ||
  argv.includes("@earendil-works/pi-coding-agent@0.84.1");

const result = (exitCode = 0, stderr = ""): CommandResult => ({
  argv: [],
  exitCode,
  stdout: "",
  stderr,
  timedOut: false,
  truncated: false,
});

const memorySnapshotStore: UpdatePiSnapshotStore = {
  async create(value, _journalPath, candidatePackageNames) {
    let modulesRoot = value.packageRoot;
    for (const _segment of value.packageName.split("/")) {
      modulesRoot = dirname(modulesRoot);
    }
    const packageNames = [
      ...new Set([
        ...Object.keys(value.corePackages),
        ...candidatePackageNames,
      ]),
    ].sort((left, right) => left.localeCompare(right));
    const binNames: ("pi" | "pi-ai" | "pi-ai.exe" | "pi.exe")[] =
      process.platform === "win32" ? ["pi.exe", "pi-ai.exe"] : ["pi", "pi-ai"];
    return {
      transactionId: "00000000-0000-4000-8000-000000000001",
      packages: packageNames.map((packageName) => {
        const pkg = value.corePackages[packageName];
        const packageRoot = join(modulesRoot, ...packageName.split("/"));
        return {
          packageName,
          packageRoot,
          digest:
            pkg === undefined
              ? null
              : createHash("sha256")
                  .update(`${packageName}:${pkg.root}:${pkg.version}`)
                  .digest("hex"),
        };
      }),
      metadata: [
        {
          name: "bun.lock",
          path: join(dirname(modulesRoot), "bun.lock"),
          digest: null,
        },
        {
          name: "bun.lockb",
          path: join(dirname(modulesRoot), "bun.lockb"),
          digest: null,
        },
        {
          name: "node_modules/.bin",
          path: join(modulesRoot, ".bin"),
          digest: null,
        },
        {
          name: "package.json",
          path: join(dirname(modulesRoot), "package.json"),
          digest: null,
        },
      ],
      globalBins: binNames.map((name) => ({
        name,
        path: join(value.globalBin, name),
        digest: null,
      })),
      packageInventory: Object.entries(value.corePackages)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([packageName, pkg]) => ({
          packageName,
          packageRoot: join(modulesRoot, ...packageName.split("/")),
          digest: createHash("sha256")
            .update(`${packageName}:${pkg.root}:${pkg.version}`)
            .digest("hex"),
        })),
    };
  },
  async validate() {},
  async restoreMetadata() {},
  async restore() {},
  async unrelatedStateMatches() {
    return true;
  },
  async matches() {
    return true;
  },
  async cleanup() {},
  async sync() {},
  async remove() {},
};

const paths = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-update-test-"));
  roots.push(root);
  return {
    lockPath: join(root, "update.lock"),
    journalPath: join(root, "recovery.json"),
    snapshotStore: memorySnapshotStore,
    executableDigest: async () => "a".repeat(64),
  };
};

const toLegacyPatchJournal = (
  source: string,
  restorePatches: boolean,
): string =>
  source
    .replace('"version": 6', '"version": 1')
    .replace(/\n}\n$/, `,\n  "restorePatches": ${restorePatches}\n}\n`);

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

  test("rejects non-file global metadata before running a candidate command", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const packageRoot = join(
      globalRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(packageRoot, { recursive: true });
    const metadataTarget = join(globalRoot, "actual-package.json");
    await writeFile(metadataTarget, "metadata target\n");
    await symlink(metadataTarget, join(globalRoot, "package.json"));
    const current = {
      ...installation("0.80.7"),
      globalBin: join(globalRoot, "bin"),
      packageRoot,
      corePackages: {
        "@earendil-works/pi-coding-agent": {
          root: packageRoot,
          version: "0.80.7",
          manifest: {},
        },
      },
    };
    let runs = 0;

    await expect(
      updatePiSafely({
        ...temp,
        checkCompatibility: async () => compatible(current),
        discover: async () => current,
        run: async () => {
          runs += 1;
          return result();
        },
      }),
    ).rejects.toThrow("is not a file");
    expect(runs).toBe(0);
  });

  test("rejects malformed global package metadata before candidate mutation", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const packageRoot = join(
      globalRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(packageRoot, { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(join(globalRoot, "package.json"), "not json\n");
    const current = {
      ...installation("0.80.7"),
      globalBin: join(globalRoot, "bin"),
      packageRoot,
      corePackages: {
        "@earendil-works/pi-coding-agent": {
          root: packageRoot,
          version: "0.80.7",
          manifest: {},
        },
      },
    };
    let runs = 0;

    await expect(
      updatePiSafely({
        ...temp,
        checkCompatibility: async () => compatible(current),
        discover: async () => current,
        run: async () => {
          runs += 1;
          return result();
        },
      }),
    ).rejects.toThrow();
    expect(runs).toBe(0);
  });

  test("publishes durable recovery state before running the candidate command", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const journalPath = join(
      dirname(temp.journalPath),
      "new",
      "nested",
      "recovery.json",
    );
    const packageRoot = join(
      globalRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(packageRoot, { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "package bytes\n");
    await writeFile(join(globalRoot, "package.json"), "{}\n");
    const atVersion = (version: string): PiInstallation => ({
      ...installation(version),
      globalBin: join(globalRoot, "bin"),
      packageRoot,
      corePackages: {
        "@earendil-works/pi-coding-agent": {
          root: packageRoot,
          version,
          manifest: {},
        },
      },
    });
    let current = atVersion("0.80.7");
    let recoveryPublished = false;
    const update = await updatePiSafely({
      ...temp,
      journalPath,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      run: async () => {
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
          version?: number;
        };
        const snapshotStats = await lstat(`${journalPath}.packages`);
        recoveryPublished =
          journal.version === 6 && snapshotStats.isDirectory();
        current = atVersion("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: true, updated: true });
    expect(recoveryPublished).toBe(true);
  });

  test("accepts an updated candidate after compatibility verification", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const calls: string[] = [];
    const commands: string[][] = [];
    const environments: (NodeJS.ProcessEnv | undefined)[] = [];
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      run: async (argv, options) => {
        commands.push(argv);
        environments.push(options?.env);
        calls.push(isCandidateInstall(argv) ? "update" : "rollback");
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
    expect(commands).toEqual([
      [
        process.execPath,
        "install",
        "-g",
        "--ignore-scripts",
        "--force",
        "@earendil-works/pi-coding-agent@0.81.0",
      ],
    ]);
    expect(environments[0]).toMatchObject({
      BUN_INSTALL_GLOBAL_DIR: "/global",
      BUN_INSTALL_BIN: "/global/bin",
    });
  });

  test("rolls back a successful install that leaves the target cohort unmet", async () => {
    const temp = await paths();
    const current = installation("0.80.7");
    let compatibilityChecks = 0;
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        compatibilityChecks += 1;
        return compatible(current);
      },
      discover: async () => current,
      run: async () => result(),
    });

    expect(update).toMatchObject({
      ok: false,
      updated: false,
      rolledBack: true,
      previousVersion: "0.80.7",
      currentVersion: "0.80.7",
    });
    expect(compatibilityChecks).toBe(3);
    await expect(readFile(temp.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
        calls.push(isCandidateInstall(argv) ? "update" : "rollback");
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
        if (isCandidateInstall(argv)) {
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
        if (isCandidateInstall(argv)) {
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

  test("keeps recovery state when rollback install exits nonzero despite matching final state", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
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
        if (isCandidateInstall(argv)) {
          current = installation("0.81.0");
          return result();
        }
        current = installation("0.80.7");
        return result(1, "rollback install ended after partial work");
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("did not complete successfully");
    expect(update.message).toContain(
      "rollback install ended after partial work",
    );
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      "pi-harness/update-recovery",
    );
  });

  test("keeps recovery state when snapshot restoration throws despite matching final state", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const update = await updatePiSafely({
      ...temp,
      snapshotStore: {
        ...memorySnapshotStore,
        async restore() {
          throw new Error("replacement copy failed");
        },
      },
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0") {
          throw new Error("candidate incompatible");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        current = isCandidateInstall(argv)
          ? installation("0.81.0")
          : installation("0.80.7");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("restoration did not complete");
    expect(update.message).toContain("replacement copy failed");
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      "pi-harness/update-recovery",
    );
  });

  test("restores exact preflight package contents after reinstalling a rollback", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const packageRoot = join(
      globalRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const patchedFile = join(packageRoot, "dist", "interactive-mode.js");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(patchedFile, "patched 0.83 viewport\n");
    await writeFile(join(globalRoot, "package.json"), "{}\n");

    const atVersion = (version: string): PiInstallation => {
      const value = installation(version);
      return {
        ...value,
        globalBin: join(globalRoot, "bin"),
        binaryRealPath: join(packageRoot, "dist", "cli.js"),
        packageRoot,
        corePackages: {
          [value.packageName]: {
            root: packageRoot,
            version,
            manifest: {},
          },
        },
      };
    };
    let current = atVersion("0.83.0");
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion === "0.84.1") {
          throw new Error("candidate incompatible");
        }
        if (
          (await readFile(patchedFile, "utf8")) !== "patched 0.83 viewport\n"
        ) {
          throw new Error("patched preflight contents were not restored");
        }
        return compatible(current, "0.84.1");
      },
      discover: async () => current,
      run: async (argv) => {
        if (isCandidateInstall(argv)) {
          await writeFile(patchedFile, "candidate 0.84 contents\n");
          current = atVersion("0.84.1");
        } else {
          await writeFile(patchedFile, "pristine 0.83 registry contents\n");
          current = atVersion("0.83.0");
        }
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: false,
      rolledBack: true,
      currentVersion: "0.83.0",
    });
    expect(await readFile(patchedFile, "utf8")).toBe("patched 0.83 viewport\n");
    await expect(
      readFile(`${temp.journalPath}.packages`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores global metadata and removes or restores candidate-only packages", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const modulesRoot = join(globalRoot, "node_modules");
    const packageRoot = join(modulesRoot, "@earendil-works", "pi-coding-agent");
    const clientRoot = join(modulesRoot, "@earendil-works", "pi-client");
    const protocolRoot = join(modulesRoot, "@earendil-works", "pi-protocol");
    const extraRoot = join(modulesRoot, "grok-mermaid");
    const binRoot = join(modulesRoot, ".bin");
    const globalBinRoot = join(globalRoot, "bin");
    const packageJson = join(globalRoot, "package.json");
    const bunLock = join(globalRoot, "bun.lock");
    const bunLockb = join(globalRoot, "bun.lockb");
    const topFile = join(packageRoot, "dist", "interactive-mode.js");
    const clientFile = join(clientRoot, "dist", "index.js");
    const protocolFile = join(protocolRoot, "dist", "index.js");
    const extraFile = join(extraRoot, "dist", "index.js");
    const piBin = join(binRoot, "pi");
    const extraBin = join(binRoot, "grok-mermaid");
    const actualPiBin = join(globalBinRoot, "pi");
    const actualPiAiBin = join(globalBinRoot, "pi-ai");
    const preflightPackageMetadata =
      '{"dependencies":{"@earendil-works/pi-coding-agent":"0.83.0","unrelated":"1.0.0"}}\n';
    const candidatePackageMetadata =
      '{"dependencies":{"@earendil-works/pi-client":"0.84.1","@earendil-works/pi-coding-agent":"0.84.1","@earendil-works/pi-protocol":"0.84.1","unrelated":"1.0.0"}}\n';
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(protocolRoot, "dist"), { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await mkdir(globalBinRoot, { recursive: true });
    await writeFile(topFile, "patched 0.83 viewport\n");
    await writeFile(protocolFile, "preflight protocol bytes\n");
    await writeFile(piBin, "preflight pi executable link\n");
    await writeFile(actualPiBin, "preflight actual pi executable\n");
    await writeFile(packageJson, preflightPackageMetadata);
    await writeFile(bunLock, "preflight text lock\n");

    const atVersion = (version: string): PiInstallation => {
      const value = installation(version);
      return {
        ...value,
        globalBin: join(globalRoot, "bin"),
        binaryRealPath: join(packageRoot, "dist", "cli.js"),
        packageRoot,
        corePackages: {
          [value.packageName]: {
            root: packageRoot,
            version,
            manifest: {},
          },
        },
      };
    };
    const withCandidateCohort = (
      value: PiInstallation,
    ): PiCompatibilityResult => ({
      ...compatible(value, "0.84.1"),
      baseline: {
        ok: true,
        issues: [],
        packages: [
          {
            name: "@earendil-works/pi-coding-agent",
            lockedVersion: "0.84.1",
            installedVersion: "0.84.1",
            installedRoot: "/local/node_modules/pi",
          },
          {
            name: "@earendil-works/pi-client",
            lockedVersion: "0.84.1",
            installedVersion: "0.84.1",
            installedRoot: "/local/node_modules/pi-client",
          },
          {
            name: "@earendil-works/pi-protocol",
            lockedVersion: "0.84.1",
            installedVersion: "0.84.1",
            installedRoot: "/local/node_modules/pi-protocol",
          },
        ],
      },
    });
    let current = atVersion("0.83.0");
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion === "0.84.1") {
          throw new Error("candidate incompatible");
        }
        if (
          (await readFile(packageJson, "utf8")) !== preflightPackageMetadata ||
          (await readFile(bunLock, "utf8")) !== "preflight text lock\n" ||
          (await readFile(protocolFile, "utf8")) !==
            "preflight protocol bytes\n" ||
          (await readFile(piBin, "utf8")) !==
            "preflight pi executable link\n" ||
          (await readFile(actualPiBin, "utf8")) !==
            "preflight actual pi executable\n"
        ) {
          throw new Error("global install state was not restored");
        }
        await expect(readFile(clientFile, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(bunLockb, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(extraFile, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(extraBin, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(actualPiAiBin, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        return withCandidateCohort(current);
      },
      discover: async () => current,
      run: async (argv) => {
        if (isCandidateInstall(argv)) {
          await writeFile(topFile, "candidate 0.84 contents\n");
          await mkdir(join(clientRoot, "dist"), { recursive: true });
          await writeFile(clientFile, "candidate client bytes\n");
          await writeFile(protocolFile, "candidate protocol bytes\n");
          await mkdir(join(extraRoot, "dist"), { recursive: true });
          await writeFile(extraFile, "candidate transitive dependency\n");
          await writeFile(piBin, "candidate pi executable link\n");
          await writeFile(extraBin, "candidate executable link\n");
          await writeFile(actualPiBin, "candidate actual pi executable\n");
          await writeFile(actualPiAiBin, "candidate pi-ai executable\n");
          await writeFile(packageJson, candidatePackageMetadata);
          await writeFile(bunLock, "candidate text lock\n");
          await writeFile(bunLockb, "candidate binary lock\n");
          current = atVersion("0.84.1");
        } else {
          expect(await readFile(packageJson, "utf8")).toBe(
            preflightPackageMetadata,
          );
          expect(await readFile(bunLock, "utf8")).toBe("preflight text lock\n");
          expect(await readFile(piBin, "utf8")).toBe(
            "preflight pi executable link\n",
          );
          await expect(readFile(extraBin, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await readFile(actualPiBin, "utf8")).toBe(
            "preflight actual pi executable\n",
          );
          await expect(readFile(actualPiAiBin, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
          await rm(extraRoot, { recursive: true });
          await writeFile(topFile, "pristine 0.83 registry contents\n");
          current = atVersion("0.83.0");
        }
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: false,
      rolledBack: true,
      currentVersion: "0.83.0",
    });
    expect(await readFile(packageJson, "utf8")).toBe(preflightPackageMetadata);
    expect(await readFile(bunLock, "utf8")).toBe("preflight text lock\n");
    expect(await readFile(protocolFile, "utf8")).toBe(
      "preflight protocol bytes\n",
    );
    expect(await readFile(piBin, "utf8")).toBe(
      "preflight pi executable link\n",
    );
    expect(await readFile(actualPiBin, "utf8")).toBe(
      "preflight actual pi executable\n",
    );
    await expect(readFile(clientFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(bunLockb, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(extraFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(extraBin, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(actualPiAiBin, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(temp.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses rollback without overwriting a concurrent unrelated global install", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const modulesRoot = join(globalRoot, "node_modules");
    const packageRoot = join(modulesRoot, "@earendil-works", "pi-coding-agent");
    const concurrentRoot = join(modulesRoot, "unrelated-global-package");
    const packageFile = join(packageRoot, "dist", "cli.js");
    const concurrentFile = join(concurrentRoot, "index.js");
    const packageJson = join(globalRoot, "package.json");
    const concurrentMetadata =
      '{"dependencies":{"@earendil-works/pi-coding-agent":"0.81.0","unrelated-global-package":"2.0.0"}}\n';
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(packageFile, "preflight package bytes\n");
    await writeFile(
      packageJson,
      '{"dependencies":{"@earendil-works/pi-coding-agent":"0.80.7","unrelated-global-package":"1.0.0"}}\n',
    );

    const atVersion = (version: string): PiInstallation => {
      const value = installation(version);
      return {
        ...value,
        globalBin: join(globalRoot, "bin"),
        binaryRealPath: packageFile,
        packageRoot,
        corePackages: {
          [value.packageName]: {
            root: packageRoot,
            version,
            manifest: {},
          },
        },
      };
    };
    let current = atVersion("0.80.7");
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
        calls.push(isCandidateInstall(argv) ? "update" : "rollback");
        if (isCandidateInstall(argv)) {
          await writeFile(packageFile, "candidate package bytes\n");
          await mkdir(concurrentRoot, { recursive: true });
          await writeFile(concurrentFile, "concurrent package bytes\n");
          await writeFile(packageJson, concurrentMetadata);
          current = atVersion("0.81.0");
        }
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("unrelated Bun global metadata changed");
    expect(calls).toEqual(["update"]);
    expect(await readFile(packageJson, "utf8")).toBe(concurrentMetadata);
    expect(await readFile(concurrentFile, "utf8")).toBe(
      "concurrent package bytes\n",
    );
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      "pi-harness/update-recovery",
    );
  });

  test("validates recovery snapshots before reinstalling rollback packages", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      snapshotStore: {
        ...memorySnapshotStore,
        async validate() {
          throw new Error("snapshot missing");
        },
      },
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0") {
          throw new Error("candidate incompatible");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        calls.push(isCandidateInstall(argv) ? "update" : "rollback");
        if (isCandidateInstall(argv)) current = installation("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("before changing Pi");
    expect(update.manualRecoveryArgv).toBeUndefined();
    expect(calls).toEqual(["update"]);
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      "pi-harness/update-recovery",
    );
  });

  test("keeps the journal when preflight metadata cannot be restored before reinstall", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    const calls: string[] = [];
    const update = await updatePiSafely({
      ...temp,
      snapshotStore: {
        ...memorySnapshotStore,
        async restoreMetadata() {
          throw new Error("metadata restore failed");
        },
      },
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0") {
          throw new Error("candidate incompatible");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv) => {
        calls.push(isCandidateInstall(argv) ? "update" : "rollback");
        if (isCandidateInstall(argv)) current = installation("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({ ok: false, rolledBack: false });
    expect(update.message).toContain("before reinstall");
    expect(update.message).toContain("metadata restore failed");
    expect(calls).toEqual(["update"]);
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      "pi-harness/update-recovery",
    );
  });

  test("keeps the journal when a rollback dependency cohort drifts", async () => {
    const temp = await paths();
    let current = installationWithTui("0.80.7", "0.80.7");
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
        current = isCandidateInstall(argv)
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
    expect(journal).toContain('"version": 6');
    expect(journal).not.toContain("restorePatches");
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
        if (isCandidateInstall(argv)) {
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

  test.each([
    [2, "lacks package-content snapshots"],
    [3, "lacks global install metadata and absent-package snapshots"],
    [4, "lacks the complete global package inventory"],
    [5, "lacks actual global-bin state"],
  ])(
    "retains a legacy v%s journal without complete restoration state",
    async (version, expectedMessage) => {
      const temp = await paths();
      let current = installation("0.80.7");
      let runs = 0;
      const dependencies = {
        ...temp,
        checkCompatibility: async () => {
          if (current.packageVersion === "0.81.0") {
            throw new Error("candidate incompatible");
          }
          return compatible(current);
        },
        discover: async () => current,
        run: async (argv: string[]) => {
          runs += 1;
          if (isCandidateInstall(argv)) {
            current = installation("0.81.0");
            return result();
          }
          return result(1, "registry unavailable");
        },
      };

      const failed = await updatePiSafely(dependencies);
      expect(failed.manualRecoveryArgv).toBeDefined();
      const currentJournal = await readFile(temp.journalPath, "utf8");
      const legacyJournal = currentJournal.replace(
        '"version": 6',
        `"version": ${version}`,
      );
      await writeFile(temp.journalPath, legacyJournal);
      const runsBeforeRecovery = runs;

      await expect(updatePiSafely(dependencies)).rejects.toThrow(
        expectedMessage,
      );
      expect(runs).toBe(runsBeforeRecovery);
      expect(await readFile(temp.journalPath, "utf8")).toBe(legacyJournal);
    },
  );

  test.each([false, true])(
    "retains a legacy v1 journal with restorePatches=%s without executing it",
    async (restorePatches) => {
      const temp = await paths();
      let current = installation("0.80.7");
      let runs = 0;
      const dependencies = {
        ...temp,
        checkCompatibility: async () => {
          if (current.packageVersion === "0.81.0") {
            throw new Error("candidate incompatible");
          }
          return compatible(current);
        },
        discover: async () => current,
        run: async (argv: string[]) => {
          runs += 1;
          if (isCandidateInstall(argv)) {
            current = installation("0.81.0");
            return result();
          }
          return result(1, "registry unavailable");
        },
      };

      const failed = await updatePiSafely(dependencies);
      expect(failed.manualRecoveryArgv).toBeDefined();
      const legacyJournal = toLegacyPatchJournal(
        await readFile(temp.journalPath, "utf8"),
        restorePatches,
      );
      await writeFile(temp.journalPath, legacyJournal);
      const runsBeforeRecovery = runs;

      await expect(updatePiSafely(dependencies)).rejects.toThrow(
        "automatic recovery is disabled because the patch mechanism was removed",
      );
      expect(runs).toBe(runsBeforeRecovery);
      expect(await readFile(temp.journalPath, "utf8")).toBe(legacyJournal);
    },
  );

  test("cleans a stable rollback temporary before clearing an already-restored journal", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const modulesRoot = join(globalRoot, "node_modules");
    const packageRoot = join(modulesRoot, "@earendil-works", "pi-coding-agent");
    const collisionRoot = join(modulesRoot, "typebox.pi-harness-rollback.tmp");
    const packageFile = join(packageRoot, "dist", "cli.js");
    const collisionFile = join(collisionRoot, "index.js");
    const packageJson = join(globalRoot, "package.json");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(collisionRoot, { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(packageFile, "preflight package bytes\n");
    await writeFile(collisionFile, "unrelated package bytes\n");
    await writeFile(packageJson, "{}\n");

    const atVersion = (version: string): PiInstallation => {
      const value = installation(version);
      return {
        ...value,
        globalBin: join(globalRoot, "bin"),
        binaryRealPath: packageFile,
        packageRoot,
        corePackages: {
          [value.packageName]: {
            root: packageRoot,
            version,
            manifest: {},
          },
        },
      };
    };
    let current = atVersion("0.80.7");
    let runs = 0;
    const dependencies = {
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion === "0.81.0") {
          throw new Error("candidate incompatible");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv: string[]) => {
        runs += 1;
        if (isCandidateInstall(argv)) {
          await writeFile(packageFile, "candidate package bytes\n");
          current = atVersion("0.81.0");
          return result();
        }
        return result(1, "rollback interrupted before reinstall");
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed).toMatchObject({ ok: false, rolledBack: false });
    const journal = JSON.parse(await readFile(temp.journalPath, "utf8")) as {
      snapshots: { transactionId: string };
    };
    const staleReplacement = join(
      globalRoot,
      `.package.json.pi-harness-rollback-${journal.snapshots.transactionId}.tmp`,
    );
    current = atVersion("0.80.7");
    await writeFile(packageFile, "preflight package bytes\n");
    await writeFile(staleReplacement, "partial replacement\n");
    const runsBeforeRecovery = runs;

    const recovered = await updatePiSafely(dependencies);
    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(recovered.message).toContain("already-restored");
    expect(runs).toBe(runsBeforeRecovery);
    expect(await readFile(collisionFile, "utf8")).toBe(
      "unrelated package bytes\n",
    );
    await expect(readFile(staleReplacement, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
        if (isCandidateInstall(argv)) {
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
        if (isCandidateInstall(argv)) {
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

  test("recovers with the captured Bun after the current runtime path changes", async () => {
    const temp = await paths();
    const capturedBun = "/opt/previous-bun/bin/bun";
    const atVersion = (version: string): PiInstallation => ({
      ...installation(version),
      bunExecutable: capturedBun,
    });
    let current = atVersion("0.80.7");
    let rollbackAvailable = false;
    const rollbackExecutables: string[] = [];
    const dependencies = {
      ...temp,
      checkCompatibility: async () => {
        if (current.packageVersion !== "0.80.7") {
          throw new Error("bad candidate");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv: string[]) => {
        if (isCandidateInstall(argv)) {
          current = atVersion("0.81.0");
          return result();
        }
        rollbackExecutables.push(argv[0] ?? "");
        if (!rollbackAvailable) return result(1, "temporary registry failure");
        current = atVersion("0.80.7");
        return result();
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv?.[0]).toBe(capturedBun);
    rollbackAvailable = true;
    const recovered = await updatePiSafely(dependencies);

    expect(recovered).toMatchObject({ ok: false, rolledBack: true });
    expect(rollbackExecutables).toEqual([capturedBun, capturedBun]);
  });

  test("refuses rollback when the captured Bun executable digest changes", async () => {
    const temp = await paths();
    let current = installation("0.80.7");
    let executableDigest = "a".repeat(64);
    let runs = 0;
    const dependencies = {
      ...temp,
      executableDigest: async () => executableDigest,
      checkCompatibility: async () => {
        if (current.packageVersion !== "0.80.7") {
          throw new Error("bad candidate");
        }
        return compatible(current);
      },
      discover: async () => current,
      run: async (argv: string[]) => {
        runs += 1;
        if (isCandidateInstall(argv)) {
          current = installation("0.81.0");
          return result();
        }
        return result(1, "temporary registry failure");
      },
    };

    const failed = await updatePiSafely(dependencies);
    expect(failed.manualRecoveryArgv).toBeDefined();
    const runsBeforeRecovery = runs;
    executableDigest = "b".repeat(64);
    const refused = await updatePiSafely(dependencies);

    expect(refused).toMatchObject({ ok: false, rolledBack: false });
    expect(refused.message).toContain("digest changed");
    expect(refused.message).toContain("manual recovery required");
    expect(refused.manualRecoveryArgv).toBeUndefined();
    expect(runs).toBe(runsBeforeRecovery);
    expect(await readFile(temp.journalPath, "utf8")).toContain(
      '"rollbackExecutableDigest"',
    );
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

    await expect(acquireUpdateLock(temp.lockPath, process.pid)).rejects.toThrow(
      "recovery nesting exceeds the safety limit",
    );
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
