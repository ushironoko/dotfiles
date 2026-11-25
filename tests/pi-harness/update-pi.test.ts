import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { PiBaselinePackage } from "../../scripts/pi-compat/baseline";
import type { PiCompatibilityResult } from "../../scripts/pi-compat/index";
import {
  discoverPiInstallation,
  piCohortPackagesForVersion,
  type PiInstallation,
} from "../../scripts/pi-compat/installation";
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
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-update-test-"));
  roots.push(root);
  return {
    lockPath: join(root, "update.lock"),
    journalPath: join(root, "recovery.json"),
    snapshotStore: memorySnapshotStore,
    executableDigest: async () => "a".repeat(64),
  };
};

const codingAgent = "@earendil-works/pi-coding-agent";
const chord = "@earendil-works/chord";
const client = "@earendil-works/pi-client";

const globalFixture = async () => {
  const {
    snapshotStore: _snapshotStore,
    executableDigest: _digest,
    ...temp
  } = await paths();
  const root = dirname(temp.journalPath);
  const globalRoot = join(root, "global");
  const globalBin = join(globalRoot, "bin");
  const binaryPath = join(
    globalBin,
    process.platform === "win32" ? "pi.exe" : "pi",
  );
  const bunExecutable = join(root, "bun");
  const packageRoot = (name: string) => join(globalRoot, "node_modules", name);
  const pkgManifest = (name: string) => join(packageRoot(name), "package.json");
  const snapshotPath = (name: string) =>
    join(
      `${temp.journalPath}.packages`,
      "packages",
      createHash("sha256").update(name).digest("hex"),
    );
  const cli = join(packageRoot(codingAgent), "dist", "cli.js");
  const metadata = join(globalRoot, "package.json");
  const lockfile = join(globalRoot, "bun.lock");
  const writePackage = async (name: string, version: string) => {
    await mkdir(packageRoot(name), { recursive: true });
    await writeFile(
      pkgManifest(name),
      JSON.stringify({
        name,
        version,
        ...(name === codingAgent ? { bin: { pi: "dist/cli.js" } } : {}),
      }),
    );
  };
  const installCohort = async (version: string) => {
    for (const name of piCohortPackagesForVersion(version)) {
      await writePackage(name, name === "typebox" ? "1.0.0" : version);
    }
    await writeFile(cli, version, { mode: 0o755 });
  };
  await mkdir(dirname(cli), { recursive: true });
  await mkdir(globalBin, { recursive: true });
  await symlink(relative(globalBin, cli), binaryPath);
  await writeFile(bunExecutable, "captured Bun executable bytes", {
    mode: 0o755,
  });
  await writeFile(metadata, "{}\n");
  const discover = () =>
    discoverPiInstallation({
      bunExecutable,
      environment: { PATH: globalBin },
      run: async (argv) => {
        expect(argv).toEqual([binaryPath, "--version"]);
        return { ...result(), stdout: await readFile(binaryPath, "utf8") };
      },
    });
  return {
    ...temp,
    root,
    globalRoot,
    globalBin,
    bunExecutable,
    packageRoot,
    pkgManifest,
    snapshotPath,
    metadata,
    lockfile,
    writePackage,
    installCohort,
    discover,
  };
};

const compatibleCohort = (
  value: PiInstallation,
  version: string,
  names: readonly PiBaselinePackage[] = piCohortPackagesForVersion(version),
): PiCompatibilityResult => ({
  installation: value,
  baseline: {
    ok: true,
    issues: [],
    packages: names.map((name) => ({
      name,
      lockedVersion: name === "typebox" ? "1.0.0" : version,
    })),
  },
});

const interruptedV7Fixture = async () => {
  const fixture = await globalFixture();
  const previous = "1.2.0";
  const candidate = "1.0.4";
  const oldChordVersion = "1.0.4";
  const metadata = JSON.stringify({
    dependencies: { [codingAgent]: previous, [chord]: oldChordVersion },
  });
  const chordBytes = join(fixture.packageRoot(chord), "patched.js");
  await fixture.installCohort(previous);
  await fixture.writePackage(chord, oldChordVersion);
  await fixture.writePackage(client, "0.84.1");
  await writeFile(chordBytes, "retained chord preflight bytes");
  await writeFile(fixture.metadata, metadata);
  await writeFile(fixture.lockfile, "preflight Bun lock");

  const discovered = await fixture.discover();
  expect(discovered.corePackages[chord]).toBeUndefined();
  const legacyInstallation: PiInstallation = {
    ...discovered,
    corePackages: {
      ...discovered.corePackages,
      [chord]: {
        root: fixture.packageRoot(chord),
        version: oldChordVersion,
        manifest: { name: chord, version: oldChordVersion },
      },
    },
  };
  await expect(
    updatePiSafely({
      ...fixture,
      checkCompatibility: async () =>
        compatibleCohort(legacyInstallation, candidate, [
          ...piCohortPackagesForVersion(candidate),
          chord,
        ]),
      run: async () => {
        await fixture.installCohort(candidate);
        await rm(chordBytes);
        await writeFile(fixture.lockfile, "interrupted candidate Bun lock");
        throw new Error("interrupted after candidate install");
      },
    }),
  ).rejects.toThrow("interrupted after candidate install");
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8")) as {
    version: number;
    previousSignature: string;
    rollbackArgv: string[];
    rollbackPackages: string[];
    snapshots: {
      packages: { packageName: string }[];
      packageInventory: { packageName: string }[];
    };
  };
  expect(journal.rollbackPackages).toContain(`${chord}@${oldChordVersion}`);
  expect(journal.snapshots.packageInventory).toContainEqual(
    expect.objectContaining({ packageName: client }),
  );
  journal.version = 7;
  journal.snapshots.packages = journal.snapshots.packages.filter(
    ({ packageName }) => packageName !== client,
  );
  await rm(fixture.snapshotPath(client), { recursive: true });
  await writeFile(fixture.journalPath, JSON.stringify(journal));
  return {
    ...fixture,
    previous,
    candidate,
    oldChordVersion,
    chordBytes,
    metadataBytes: metadata,
    journal,
  };
};

const toLegacyPatchJournal = (
  source: string,
  restorePatches: boolean,
): string =>
  source
    .replace('"version": 8', '"version": 1')
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
      binaryRealPath: join(packageRoot, "dist", "cli.js"),
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
      binaryRealPath: join(packageRoot, "dist", "cli.js"),
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

  test("snapshots Bun bin symlinks when fs.cp normalizes their mode", async () => {
    const { snapshotStore: _snapshotStore, ...temp } = await paths();
    const globalRoot = join(temp.journalPath, "..", "global");
    const modulesRoot = join(globalRoot, "node_modules");
    const packageRoot = join(modulesRoot, "@earendil-works", "pi-coding-agent");
    const packageBinary = join(packageRoot, "dist", "cli.js");
    const binRoot = join(modulesRoot, ".bin");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await writeFile(packageBinary, "preflight CLI bytes\n");
    await writeFile(join(globalRoot, "package.json"), "{}\n");
    await symlink(
      "../@earendil-works/pi-coding-agent/dist/cli.js",
      join(binRoot, "pi"),
    );

    const atVersion = (version: string): PiInstallation => {
      const value = installation(version);
      return {
        ...value,
        globalBin: join(globalRoot, "bin"),
        binaryRealPath: packageBinary,
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
    const update = await updatePiSafely({
      ...temp,
      checkCompatibility: async () => compatible(current),
      discover: async () => current,
      run: async () => {
        runs += 1;
        current = atVersion("0.81.0");
        return result();
      },
    });

    expect(update).toMatchObject({
      ok: true,
      updated: true,
      currentVersion: "0.81.0",
    });
    expect(runs).toBe(1);
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
      binaryRealPath: join(packageRoot, "dist", "cli.js"),
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
        const snapshotStats = await lstat(`${journalPath}.packages`);
        const journal = await readFile(journalPath, "utf8");
        recoveryPublished =
          journal.includes('"version": 8') && snapshotStats.isDirectory();
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

  test.each([false, true])(
    "migrates the 0.84 cohort to 1.0.4 with candidate rejection %s",
    async (rejectCandidate) => {
      const temp = await paths();
      const targetPackages = [
        ...piCohortPackagesForVersion("1.0.4"),
        "@earendil-works/chord",
      ] as const;
      const atVersion = (version: string): PiInstallation => ({
        ...installation(version),
        corePackages: Object.fromEntries(
          (version === "1.0.4"
            ? targetPackages
            : piCohortPackagesForVersion(version)
          ).map((name) => [
            name,
            {
              root: join("/global/node_modules", name),
              version: name === "typebox" ? "1.3.27" : version,
              manifest: {},
            },
          ]),
        ),
      });
      const previous = atVersion("0.84.4");
      const candidate = atVersion("1.0.4");
      let current = previous;
      const commands: string[][] = [];
      const update = await updatePiSafely({
        ...temp,
        checkCompatibility: async () => {
          if (rejectCandidate && current === candidate) {
            throw new Error("candidate incompatible");
          }
          return {
            baseline: {
              ok: true,
              issues: [],
              packages: targetPackages.map((name) => ({
                name,
                lockedVersion: candidate.corePackages[name]?.version,
              })),
            },
            installation: current,
          };
        },
        discover: async () => current,
        run: async (argv) => {
          commands.push(argv);
          current = argv.includes("@earendil-works/pi-coding-agent@1.0.4")
            ? candidate
            : previous;
          return result();
        },
      });

      expect(update).toMatchObject({
        ok: !rejectCandidate,
        updated: !rejectCandidate,
        rolledBack: rejectCandidate,
        currentVersion: rejectCandidate ? "0.84.4" : "1.0.4",
      });
      expect(commands[0]?.slice(5)).toEqual(
        targetPackages.map(
          (name) => `${name}@${candidate.corePackages[name]?.version}`,
        ),
      );
      expect(commands[0]).not.toContain("@earendil-works/pi-client@1.0.4");
      expect(commands[0]).not.toContain("@earendil-works/pi-protocol@1.0.4");
      if (rejectCandidate) {
        expect(commands[1]).toContain("@earendil-works/pi-client@0.84.4");
        expect(commands[1]).toContain("@earendil-works/pi-protocol@0.84.4");
      }
    },
  );

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

  test.each([
    { previousVersion: "1.0.4", concurrentChordPin: false },
    { previousVersion: "1.6.0", concurrentChordPin: false },
    { previousVersion: "1.6.0", concurrentChordPin: true },
  ])(
    "handles pi-schema and retained chord during rollback from $previousVersion (pin drift: $concurrentChordPin)",
    async ({ previousVersion, concurrentChordPin }) => {
      const { snapshotStore: _snapshotStore, ...temp } = await paths();
      const globalRoot = join(dirname(temp.journalPath), "global");
      const modules = join(globalRoot, "node_modules");
      const globalBin = join(globalRoot, "bin");
      const metadata = join(globalRoot, "package.json");
      const coding = "@earendil-works/pi-coding-agent";
      const chord = "@earendil-works/chord";
      const schema = "@earendil-works/pi-schema";
      const packageFile = (name: string) => join(modules, name, "package.json");
      const writePackage = async (name: string, bytes: string) => {
        const file = packageFile(name);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
      };
      const atVersion = (version: string): PiInstallation => {
        const coreName = version === "1.0.4" ? chord : schema;
        const packageRoot = join(modules, coding);
        return {
          ...installation(version),
          globalBin,
          binaryPath: join(globalBin, "pi"),
          binaryRealPath: join(packageRoot, "dist/cli.js"),
          packageRoot,
          corePackages: {
            [coding]: { root: packageRoot, version, manifest: {} },
            [coreName]: {
              root: join(modules, coreName),
              version,
              manifest: {},
            },
          },
        };
      };
      const hadSchema = previousVersion === "1.6.0";
      const originalMetadata = JSON.stringify({
        dependencies: { [coding]: previousVersion, [chord]: "1.0.4" },
      });
      const changedMetadata = JSON.stringify({
        dependencies: {
          [coding]: "1.6.0",
          [schema]: "1.6.0",
          [chord]: concurrentChordPin ? "1.0.5" : "1.0.4",
        },
      });
      await mkdir(globalBin, { recursive: true });
      await writeFile(metadata, originalMetadata);
      await writePackage(coding, "preflight coding-agent bytes");
      await writePackage(chord, "preflight chord bytes");
      if (hadSchema) await writePackage(schema, "preflight pi-schema bytes");

      const previous = atVersion(previousVersion);
      let current = previous;
      let candidateRunning = false;
      const calls: string[][] = [];
      const update = await updatePiSafely({
        ...temp,
        discover: async () => current,
        checkCompatibility: async () => {
          if (candidateRunning) throw new Error("candidate incompatible");
          return {
            baseline: {
              ok: true,
              issues: [],
              packages: [
                { name: coding, lockedVersion: "1.6.0" },
                { name: schema, lockedVersion: "1.6.0" },
              ],
            },
            installation: current,
          };
        },
        run: async (argv) => {
          calls.push(argv.slice(5));
          if (calls.length === 1) {
            current = atVersion("1.6.0");
            candidateRunning = true;
            await writeFile(metadata, changedMetadata);
            await writePackage(schema, "candidate pi-schema bytes");
            await writePackage(chord, "changed chord bytes");
          } else {
            expect(await readFile(metadata, "utf8")).toBe(originalMetadata);
            current = previous;
            candidateRunning = false;
            await writePackage(coding, "registry coding-agent bytes");
            await writePackage(chord, "registry chord bytes");
            if (hadSchema)
              await writePackage(schema, "registry pi-schema bytes");
          }
          return result();
        },
      });

      expect(calls[0]).toEqual([`${coding}@1.6.0`, `${schema}@1.6.0`]);
      if (concurrentChordPin) {
        expect(calls).toHaveLength(1);
        expect(update.message).toContain(
          "unrelated Bun global metadata changed",
        );
        expect(await readFile(metadata, "utf8")).toBe(changedMetadata);
        await expect(
          assertNoPendingUpdateRecovery(temp.journalPath),
        ).rejects.toThrow("recovery is pending");
        return;
      }
      expect(update).toMatchObject({
        ok: false,
        rolledBack: true,
        currentVersion: previousVersion,
      });
      expect(calls[1]).toEqual([
        `${coding}@${previousVersion}`,
        hadSchema ? `${schema}@1.6.0` : `${chord}@1.0.4`,
      ]);
      expect(await readFile(packageFile(coding), "utf8")).toBe(
        "preflight coding-agent bytes",
      );
      expect(await readFile(packageFile(chord), "utf8")).toBe(
        "preflight chord bytes",
      );
      if (hadSchema) {
        expect(await readFile(packageFile(schema), "utf8")).toBe(
          "preflight pi-schema bytes",
        );
      } else {
        await expect(lstat(packageFile(schema))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(lstat(temp.journalPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.each(["successful update", "rollback"])(
    "preserves a retained Bun development symlink during %s",
    async (outcome) => {
      const fixture = await globalFixture();
      const previous = "1.2.0";
      const candidate = "1.6.0";
      const linkPath = fixture.packageRoot(client);
      const target = join(fixture.root, "development-client");
      const rawTarget = relative(dirname(linkPath), target);
      const targetFile = join(target, "source.js");
      await fixture.installCohort(previous);
      await mkdir(target);
      await writeFile(targetFile, "external development bytes");
      await symlink(rawTarget, linkPath);
      await writeFile(
        fixture.metadata,
        JSON.stringify({
          dependencies: { [client]: "link:development-client" },
        }),
      );
      const calls: string[][] = [];
      const update = await updatePiSafely({
        ...fixture,
        checkCompatibility: async () => {
          const current = await fixture.discover();
          if (outcome === "rollback" && current.packageVersion === candidate) {
            throw new Error("candidate incompatible");
          }
          return compatibleCohort(current, candidate);
        },
        run: async (argv) => {
          calls.push(argv.slice(5));
          if (calls.length === 1) {
            expect(await readlink(fixture.snapshotPath(client))).toBe(
              rawTarget,
            );
            await fixture.installCohort(candidate);
            if (outcome === "rollback") {
              await rm(linkPath);
              await symlink("missing-replacement-target", linkPath);
              await writeFile(
                targetFile,
                "edited outside the global installation",
              );
            }
          } else {
            await fixture.installCohort(previous);
          }
          return result();
        },
      });

      const rolledBack = outcome === "rollback";
      expect(update).toMatchObject({
        ok: !rolledBack,
        updated: !rolledBack,
        rolledBack,
        currentVersion: rolledBack ? previous : candidate,
      });
      expect(calls).toHaveLength(rolledBack ? 2 : 1);
      expect(calls.flat().some((spec) => spec.startsWith(`${client}@`))).toBe(
        false,
      );
      expect(await readlink(linkPath)).toBe(rawTarget);
      expect(await readFile(targetFile, "utf8")).toBe(
        rolledBack
          ? "edited outside the global installation"
          : "external development bytes",
      );
      await expect(lstat(fixture.journalPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.each(["active", "candidate-only"])(
    "rejects a development symlink at a package root before mutation (%s)",
    async (scope) => {
      const fixture = await globalFixture();
      const previous = "1.2.0";
      const active = scope === "active";
      const name = active ? "@earendil-works/pi-tui" : client;
      await fixture.installCohort(previous);
      const prior = await fixture.discover();
      const target = join(fixture.root, "development-package");
      await mkdir(target);
      await rm(fixture.packageRoot(name), { force: true, recursive: true });
      await symlink(target, fixture.packageRoot(name));
      let runs = 0;
      await expect(
        updatePiSafely({
          ...fixture,
          checkCompatibility: async () =>
            compatibleCohort(prior, "1.6.0", [
              ...piCohortPackagesForVersion("1.6.0"),
              ...(active ? [] : ([client] as const)),
            ]),
          run: async () => {
            runs += 1;
            return result();
          },
        }),
      ).rejects.toThrow("is not a directory");
      expect(runs).toBe(0);
      expect(await readlink(fixture.packageRoot(name))).toBe(target);
      await expect(lstat(fixture.journalPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

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
    expect(journal).toContain('"version": 8');
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

    await writeFile(
      temp.journalPath,
      journal.replaceAll(
        "@earendil-works/pi-tui",
        "@earendil-works/pi-unrecognized",
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
    [6, "uses non-portable symlink mode digests"],
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
        '"version": 8',
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

  test("recovers an unfinished v8 journal before attempting another update", async () => {
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

  test.each([
    { drift: "none", failure: "" },
    { drift: "already restored", failure: "" },
    {
      drift: "reinstalled name",
      failure: "reinstalled pi package cohort does not match preflight",
    },
    {
      drift: "reinstalled version",
      failure: "reinstalled pi package cohort does not match preflight",
    },
    {
      drift: "restored version",
      failure: "restored pi package cohort does not match preflight",
    },
  ])(
    "recovers a v7 Pi 1.2 journal with retained chord (drift: $drift)",
    async ({ drift, failure }) => {
      const fixture = await interruptedV7Fixture();
      const alreadyRestored = drift === "already restored";
      if (alreadyRestored) {
        await fixture.installCohort(fixture.previous);
        await writeFile(fixture.chordBytes, "retained chord preflight bytes");
        await writeFile(fixture.lockfile, "preflight Bun lock");
      }
      const calls: string[][] = [];
      const recovered = await updatePiSafely({
        ...fixture,
        checkCompatibility: async () => {
          const current = await fixture.discover();
          expect(current.corePackages[chord]).toBeUndefined();
          if (
            current.packageVersion === fixture.previous &&
            drift === "restored version"
          ) {
            await fixture.writePackage(chord, "1.0.5");
          }
          return compatibleCohort(current, fixture.candidate);
        },
        run: async (argv, options) => {
          calls.push(argv);
          expect(options?.env).toMatchObject({
            BUN_INSTALL_GLOBAL_DIR: fixture.globalRoot,
            BUN_INSTALL_BIN: fixture.globalBin,
          });
          expect(await readFile(fixture.metadata, "utf8")).toBe(
            fixture.metadataBytes,
          );
          expect(await readFile(fixture.lockfile, "utf8")).toBe(
            "preflight Bun lock",
          );
          await fixture.installCohort(fixture.previous);
          await fixture.writePackage(
            chord,
            drift === "reinstalled version" ? "1.0.5" : fixture.oldChordVersion,
          );
          if (drift === "reinstalled name") {
            await writeFile(
              fixture.pkgManifest(chord),
              JSON.stringify({
                name: client,
                version: fixture.oldChordVersion,
              }),
            );
          }
          await writeFile(fixture.chordBytes, "registry chord bytes");
          return result();
        },
      });
      expect(calls).toEqual(
        alreadyRestored ? [] : [fixture.journal.rollbackArgv],
      );
      expect(recovered).toMatchObject({
        ok: false,
        rolledBack: failure === "",
      });
      if (failure) {
        expect(recovered.message).toContain(failure);
        expect(await readFile(fixture.journalPath, "utf8")).toBe(
          JSON.stringify(fixture.journal),
        );
      } else {
        await expect(lstat(fixture.journalPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await readFile(fixture.chordBytes, "utf8")).toBe(
        drift.startsWith("reinstalled")
          ? "registry chord bytes"
          : "retained chord preflight bytes",
      );
    },
  );

  test.each([
    { tamper: "recorded path", failure: "invalid pi update recovery journal" },
    {
      tamper: "recorded version and argv",
      failure: "recorded package identity differs from snapshot",
    },
    {
      tamper: "snapshot contents",
      failure: "rollback snapshot digest mismatch",
    },
    {
      tamper: "Bun executable",
      failure: "captured Bun executable digest changed",
    },
  ])(
    "retains a tampered v7 journal without reinstalling ($tamper)",
    async ({ tamper, failure }) => {
      const fixture = await interruptedV7Fixture();
      const { journal } = fixture;
      if (tamper === "recorded path") {
        journal.previousSignature = journal.previousSignature.replace(
          fixture.packageRoot(chord),
          fixture.packageRoot(client),
        );
      } else if (tamper === "recorded version and argv") {
        const oldSpec = `${chord}@${fixture.oldChordVersion}`;
        const newSpec = `${chord}@1.0.5`;
        journal.previousSignature = journal.previousSignature.replace(
          `"root":${JSON.stringify(fixture.packageRoot(chord))},"version":"${fixture.oldChordVersion}"`,
          `"root":${JSON.stringify(fixture.packageRoot(chord))},"version":"1.0.5"`,
        );
        journal.rollbackPackages = journal.rollbackPackages.map((spec) =>
          spec === oldSpec ? newSpec : spec,
        );
        journal.rollbackArgv = journal.rollbackArgv.map((arg) =>
          arg === oldSpec ? newSpec : arg,
        );
      } else if (tamper === "snapshot contents") {
        await writeFile(
          join(fixture.snapshotPath(chord), "patched.js"),
          "tampered chord snapshot",
        );
      } else {
        await writeFile(
          fixture.bunExecutable,
          "different Bun executable bytes",
        );
      }
      const journalBytes = JSON.stringify(journal);
      await writeFile(fixture.journalPath, journalBytes);
      let runs = 0;
      const recovery = updatePiSafely({
        ...fixture,
        checkCompatibility: async () =>
          compatibleCohort(await fixture.discover(), fixture.candidate),
        run: async () => {
          runs += 1;
          return result();
        },
      });
      if (tamper === "recorded path") {
        await expect(recovery).rejects.toThrow(failure);
      } else {
        const refused = await recovery;
        expect(refused).toMatchObject({ ok: false, rolledBack: false });
        expect(refused.message).toContain(failure);
      }
      expect(runs).toBe(0);
      expect(await readFile(fixture.lockfile, "utf8")).toBe(
        "interrupted candidate Bun lock",
      );
      expect(await readFile(fixture.journalPath, "utf8")).toBe(journalBytes);
    },
  );

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
