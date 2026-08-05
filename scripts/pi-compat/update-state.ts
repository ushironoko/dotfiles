import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { PiCompatibilityResult } from "./index";
import type { PiInstallation } from "./installation";
import { runCommand, type CommandResult, type CommandRunner } from "./process";

interface RecoveryJournal {
  schema: "pi-harness/update-recovery";
  version: 1;
  createdAt: string;
  packageName: string;
  previousVersion: string;
  previousSignature: string;
  rollbackArgv: string[];
  rollbackPackages?: string[];
  restorePatches?: boolean;
}

export type PiPatchPhase =
  | "preflight"
  | "candidate"
  | "rollback"
  | "recovery"
  | "unchanged";

export const allowsUnsupportedPatchGeneration = (
  phase: PiPatchPhase,
): boolean => phase === "preflight" || phase === "unchanged";

export interface UpdatePiDependencies {
  checkCompatibility(): Promise<PiCompatibilityResult>;
  discover(): Promise<PiInstallation>;
  inspectPatches?(installation: PiInstallation): Promise<boolean>;
  applyPatches?(
    installation: PiInstallation,
    phase: PiPatchPhase,
  ): Promise<boolean>;
  run?: CommandRunner;
  lockPath?: string;
  journalPath?: string;
  pid?: number;
}

export interface UpdatePiResult {
  ok: boolean;
  updated: boolean;
  rolledBack: boolean;
  previousVersion?: string;
  currentVersion?: string;
  message: string;
  manualRecoveryArgv?: string[];
}

interface UpdateLock {
  release(): Promise<void>;
}

export interface UpdateLockPublishState {
  path: string;
  publishPath: string;
  token: string;
}

export interface UpdateLockTestSeams {
  afterPublishPrepared?(state: UpdateLockPublishState): void | Promise<void>;
  afterPublished?(state: UpdateLockPublishState): void | Promise<void>;
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lockOwner = (raw: string): number => Number(raw.split(":", 1)[0]);

const createOwnedLock = async (
  path: string,
  pid: number,
  testSeams?: UpdateLockTestSeams,
): Promise<UpdateLock> => {
  const nonce = randomUUID();
  const state: UpdateLockPublishState = {
    path,
    publishPath: `${path}.publish-${pid}-${nonce}`,
    token: `${pid}:${nonce}\n`,
  };
  await writeFile(state.publishPath, state.token, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await testSeams?.afterPublishPrepared?.(state);
  try {
    await link(state.publishPath, path);
    await testSeams?.afterPublished?.(state);
  } finally {
    await rm(state.publishPath, { force: true }).catch(() => undefined);
  }

  const { token } = state;

  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= (async () => {
        const current = await readFile(path, "utf8").catch(() => undefined);
        if (current !== token) {
          throw new Error("pi update lock ownership changed before release");
        }
        await rm(path);
      })();
      return releasePromise;
    },
  };
};

const acquireUpdateLockInternal = async (
  path: string,
  pid: number,
  depth: number,
  recoveryRoot: string,
  testSeams?: UpdateLockTestSeams,
): Promise<UpdateLock> => {
  if (depth > 8) {
    throw new Error("pi update lock recovery nesting exceeds the safety limit");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createOwnedLock(path, pid, testSeams);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new Error("pi update lock exists but cannot be verified");
    }
    const owner = lockOwner(raw);
    if (!Number.isInteger(owner) || owner <= 0) {
      throw new Error("pi update lock exists but has no valid owner pid");
    }
    if (processAlive(owner)) {
      throw new Error(`another pi update is active (pid ${owner})`);
    }

    const generation = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const recoveryPath =
      depth === 0
        ? `${recoveryRoot}.recovery-${generation}`
        : `${recoveryRoot}.recovery-${depth + 1}-${generation}`;
    const recoveryLock = await acquireUpdateLockInternal(
      recoveryPath,
      pid,
      depth + 1,
      recoveryRoot,
      testSeams,
    );
    try {
      const current = await readFile(path, "utf8").catch(() => undefined);
      if (current !== raw) continue;
      await rm(path);
    } finally {
      await recoveryLock.release();
    }
  }
  throw new Error("could not recover stale pi update lock");
};

export const acquireUpdateLock = async (
  path: string,
  pid = process.pid,
  testSeams?: UpdateLockTestSeams,
): Promise<UpdateLock> => acquireUpdateLockInternal(path, pid, 0, path, testSeams);

export const defaultUpdateLockPath = (): string =>
  join(tmpdir(), `pi-harness-update-${process.getuid?.() ?? "user"}.lock`);
export const defaultUpdateJournalPath = (): string =>
  join(homedir(), ".cache", "pi-harness", "pi-update-recovery.json");

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const packageVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const validPackageSpec = (value: string): boolean => {
  const separator = value.lastIndexOf("@");
  return (
    separator > 0 &&
    packageNamePattern.test(value.slice(0, separator)) &&
    packageVersionPattern.test(value.slice(separator + 1))
  );
};

interface RecordedSignature {
  packageRoot: string;
  binaryRealPath: string;
  packageName: string;
  packageVersion: string;
  core: Record<string, { root: string; version: string }>;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseRecordedSignature = (
  source: string,
): RecordedSignature | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  const value = recordValue(parsed);
  const coreValue = recordValue(value?.core);
  if (
    value === undefined ||
    coreValue === undefined ||
    typeof value.packageRoot !== "string" ||
    !isAbsolute(value.packageRoot) ||
    typeof value.binaryRealPath !== "string" ||
    !isAbsolute(value.binaryRealPath) ||
    typeof value.packageName !== "string" ||
    !packageNamePattern.test(value.packageName) ||
    typeof value.packageVersion !== "string" ||
    !packageVersionPattern.test(value.packageVersion)
  ) {
    return undefined;
  }
  const coreEntries = Object.entries(coreValue);
  if (coreEntries.length === 0 || coreEntries.length > 64) return undefined;
  const core: RecordedSignature["core"] = {};
  for (const [name, rawPackage] of coreEntries) {
    const pkg = recordValue(rawPackage);
    if (
      !packageNamePattern.test(name) ||
      pkg === undefined ||
      typeof pkg.root !== "string" ||
      !isAbsolute(pkg.root) ||
      typeof pkg.version !== "string" ||
      !packageVersionPattern.test(pkg.version)
    ) {
      return undefined;
    }
    core[name] = { root: pkg.root, version: pkg.version };
  }
  const top = core[value.packageName];
  if (
    top === undefined ||
    top.root !== value.packageRoot ||
    top.version !== value.packageVersion
  ) {
    return undefined;
  }
  return {
    packageRoot: value.packageRoot,
    binaryRealPath: value.binaryRealPath,
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    core,
  };
};

const packageSpecsFromSignature = (signature: RecordedSignature): string[] => [
  `${signature.packageName}@${signature.packageVersion}`,
  ...Object.entries(signature.core)
    .filter(([name]) => name !== signature.packageName)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, pkg]) => `${name}@${pkg.version}`),
];

const validRollbackCommand = (
  value: RecoveryJournal,
  expectedPackages: string[],
): boolean => {
  if (
    !Array.isArray(value.rollbackArgv) ||
    value.rollbackArgv.some((item) => typeof item !== "string") ||
    !isAbsolute(value.rollbackArgv[0] ?? "") ||
    value.rollbackArgv[1] !== "install" ||
    value.rollbackArgv[2] !== "-g" ||
    value.rollbackArgv[3] !== "--ignore-scripts"
  ) {
    return false;
  }
  if (value.rollbackPackages === undefined) {
    return (
      value.rollbackArgv.length === 5 &&
      value.rollbackArgv[4] === expectedPackages[0]
    );
  }
  return (
    Array.isArray(value.rollbackPackages) &&
    value.rollbackPackages.length === expectedPackages.length &&
    value.rollbackPackages.every(
      (item, index) =>
        typeof item === "string" &&
        validPackageSpec(item) &&
        item === expectedPackages[index],
    ) &&
    value.rollbackArgv.length === 5 + expectedPackages.length &&
    value.rollbackArgv[4] === "--force" &&
    value.rollbackArgv
      .slice(5)
      .every((item, index) => item === expectedPackages[index])
  );
};

const writeJournal = async (
  path: string,
  journal: RecoveryJournal,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

const readJournal = async (
  path: string,
): Promise<RecoveryJournal | undefined> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as RecoveryJournal;
    const signature =
      typeof value.previousSignature === "string"
        ? parseRecordedSignature(value.previousSignature)
        : undefined;
    if (
      value.schema !== "pi-harness/update-recovery" ||
      value.version !== 1 ||
      typeof value.packageName !== "string" ||
      typeof value.previousVersion !== "string" ||
      signature === undefined ||
      signature.packageName !== value.packageName ||
      signature.packageVersion !== value.previousVersion ||
      (value.restorePatches !== undefined &&
        typeof value.restorePatches !== "boolean")
    ) {
      throw new Error("invalid pi update recovery journal");
    }
    const rollbackPackages = packageSpecsFromSignature(signature);
    if (!validRollbackCommand(value, rollbackPackages)) {
      throw new Error("invalid pi update recovery journal");
    }
    return {
      ...value,
      rollbackPackages,
      rollbackArgv: [
        value.rollbackArgv[0] ?? "",
        "install",
        "-g",
        "--ignore-scripts",
        "--force",
        ...rollbackPackages,
      ],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const assertNoPendingUpdateRecovery = async (
  journalPath = defaultUpdateJournalPath(),
): Promise<void> => {
  if ((await readJournal(journalPath)) !== undefined) {
    throw new Error(
      "pi update recovery is pending; run `bun run update:pi` before applying patches",
    );
  }
};

const successful = (result: CommandResult): boolean =>
  !result.timedOut && result.exitCode === 0;

const installationSignature = (installation: PiInstallation): string =>
  JSON.stringify({
    packageRoot: installation.packageRoot,
    binaryRealPath: installation.binaryRealPath,
    packageName: installation.packageName,
    packageVersion: installation.packageVersion,
    core: Object.fromEntries(
      Object.entries(installation.corePackages)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, pkg]) => [name, { root: pkg.root, version: pkg.version }]),
    ),
  });

const rollbackPackageSpecs = (installation: PiInstallation): string[] => [
  `${installation.packageName}@${installation.packageVersion}`,
  ...Object.entries(installation.corePackages)
    .filter(([name]) => name !== installation.packageName)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, pkg]) => `${name}@${pkg.version}`),
];

const manualRecoveryFollowUp =
  "recovery remains journaled; rerun `bun run update:pi` when Bun's registry/cache is available so the exact cohort is restored without a shell, required patches are reapplied, and the result is verified";

const rollback = async (
  journal: RecoveryJournal,
  dependencies: UpdatePiDependencies,
  run: CommandRunner,
  journalPath: string,
): Promise<UpdatePiResult> => {
  const result = await run(journal.rollbackArgv, {
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 512 * 1024,
  });
  if (!successful(result)) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `automatic rollback failed: ${result.stderr || result.stdout}; ${manualRecoveryFollowUp}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
  try {
    const restoredInstallation = await dependencies.discover();
    if (journal.restorePatches === true) {
      await dependencies.applyPatches?.(restoredInstallation, "rollback");
    }
    const restored = await dependencies.checkCompatibility();
    if (restored.installation.packageVersion !== journal.previousVersion) {
      throw new Error(
        `restored version ${restored.installation.packageVersion} != ${journal.previousVersion}`,
      );
    }
    if (
      installationSignature(restored.installation) !== journal.previousSignature
    ) {
      throw new Error("restored pi package cohort does not match preflight");
    }
    await rm(journalPath, { force: true });
    return {
      ok: false,
      updated: false,
      rolledBack: true,
      previousVersion: journal.previousVersion,
      currentVersion: restored.installation.packageVersion,
      message: `candidate was incompatible; restored pi ${journal.previousVersion}`,
    };
  } catch (error) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `rollback installed but verification failed: ${String(error)}; ${manualRecoveryFollowUp}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
};

export const updatePiSafely = async (
  dependencies: UpdatePiDependencies,
): Promise<UpdatePiResult> => {
  const run = dependencies.run ?? runCommand;
  const lockPath = dependencies.lockPath ?? defaultUpdateLockPath();
  const journalPath =
    dependencies.journalPath ?? defaultUpdateJournalPath();
  const lock = await acquireUpdateLock(lockPath, dependencies.pid);
  try {
    const unfinished = await readJournal(journalPath);
    if (unfinished !== undefined) {
      // A pristine-state journal can exist while preflight patching is only
      // partially applied. Paths and versions cannot prove file-level state,
      // so always reinstall instead of accepting the current cohort.
      if (unfinished.restorePatches === false) {
        return rollback(unfinished, dependencies, run, journalPath);
      }
      try {
        const current = await dependencies.discover();
        if (unfinished.restorePatches === true) {
          await dependencies.applyPatches?.(current, "recovery");
        }
        const verified = await dependencies.checkCompatibility();
        if (
          installationSignature(current) === unfinished.previousSignature &&
          installationSignature(verified.installation) ===
            unfinished.previousSignature
        ) {
          await rm(journalPath, { force: true });
          return {
            ok: false,
            updated: false,
            rolledBack: true,
            previousVersion: unfinished.previousVersion,
            currentVersion: verified.installation.packageVersion,
            message:
              "verified an already-restored installation and cleared its recovery journal; rerun update:pi to update",
          };
        }
      } catch {
        // The interrupted state is not known-good; reinstall below.
      }
      return rollback(unfinished, dependencies, run, journalPath);
    }

    // Establish a known-good rollback target before any updater mutation,
    // including application of the exact-version sticky patch. A read-only
    // probe records whether the source cohort is already fully patched; after
    // preflight patch verification the journal is rewritten with that result.
    let preflight = await dependencies.checkCompatibility();
    let previous = preflight.installation;
    const restoreExistingPatches =
      (await dependencies.inspectPatches?.(previous)) ?? false;
    const rollbackPackages = rollbackPackageSpecs(previous);
    const rollbackArgv = [
      previous.bunExecutable,
      "install",
      "-g",
      "--ignore-scripts",
      "--force",
      ...rollbackPackages,
    ];
    let journal: RecoveryJournal = {
      schema: "pi-harness/update-recovery",
      version: 1,
      createdAt: new Date().toISOString(),
      packageName: previous.packageName,
      previousVersion: previous.packageVersion,
      previousSignature: installationSignature(previous),
      rollbackArgv,
      rollbackPackages,
      restorePatches: restoreExistingPatches,
    };
    await writeJournal(journalPath, journal);
    if (dependencies.applyPatches !== undefined) {
      try {
        const hasPatchGeneration = await dependencies.applyPatches(
          previous,
          "preflight",
        );
        preflight = await dependencies.checkCompatibility();
        previous = preflight.installation;
        journal = {
          ...journal,
          previousSignature: installationSignature(previous),
          restorePatches: hasPatchGeneration,
        };
        await writeJournal(journalPath, journal);
      } catch {
        return rollback(journal, dependencies, run, journalPath);
      }
    }

    const updateEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dirname(previous.bunExecutable)}:${process.env.PATH ?? ""}`,
    };
    const updateResult = await run(
      [previous.bunExecutable, previous.binaryRealPath, "update", "--self"],
      {
        env: updateEnv,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 512 * 1024,
      },
    );

    let discovered: PiInstallation | undefined;
    try {
      discovered = await dependencies.discover();
    } catch {
      // A partial update can make discovery fail; rollback below.
    }
    const changed =
      discovered === undefined ||
      installationSignature(discovered) !== installationSignature(previous);

    if (!successful(updateResult) && !changed) {
      try {
        const unchanged = discovered ?? (await dependencies.discover());
        await dependencies.applyPatches?.(unchanged, "unchanged");
        const verified = await dependencies.checkCompatibility();
        if (
          installationSignature(verified.installation) ===
          installationSignature(previous)
        ) {
          await rm(journalPath, { force: true });
          return {
            ok: false,
            updated: false,
            rolledBack: false,
            previousVersion: previous.packageVersion,
            currentVersion: previous.packageVersion,
            message: `pi update failed without changing the verified installation: ${updateResult.stderr || updateResult.stdout}`,
          };
        }
      } catch {
        // Metadata can stay unchanged after a partial in-place mutation.
      }
      return rollback(journal, dependencies, run, journalPath);
    }

    if (successful(updateResult)) {
      try {
        const candidateInstallation =
          discovered ?? (await dependencies.discover());
        await dependencies.applyPatches?.(candidateInstallation, "candidate");
        const candidate = await dependencies.checkCompatibility();
        await rm(journalPath, { force: true });
        return {
          ok: true,
          updated:
            installationSignature(candidate.installation) !==
            installationSignature(previous),
          rolledBack: false,
          previousVersion: previous.packageVersion,
          currentVersion: candidate.installation.packageVersion,
          message: `pi ${candidate.installation.packageVersion} passed compatibility checks`,
        };
      } catch {
        // Candidate is incompatible; rollback below.
      }
    }

    return rollback(journal, dependencies, run, journalPath);
  } finally {
    await lock.release();
  }
};
