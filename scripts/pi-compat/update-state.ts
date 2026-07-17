import { dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
}

export interface UpdatePiDependencies {
  checkCompatibility(): Promise<PiCompatibilityResult>;
  discover(): Promise<PiInstallation>;
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

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const acquireUpdateLock = async (
  path: string,
  pid = process.pid,
): Promise<UpdateLock> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${pid}\n`);
      await handle.close();
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number((await readFile(path, "utf8")).trim());
      } catch {
        // Treat an unreadable lock as active rather than deleting blindly.
      }
      if (!Number.isInteger(owner) || owner <= 0) {
        throw new Error("pi update lock exists but has no valid owner pid");
      }
      if (processAlive(owner)) {
        throw new Error(`another pi update is active (pid ${owner})`);
      }
      if (attempt === 0) {
        await rm(path, { force: true });
        continue;
      }
      throw new Error("could not recover stale pi update lock");
    }
  }
  throw new Error("could not acquire pi update lock");
};

const defaultLockPath = (): string =>
  join(tmpdir(), `pi-harness-update-${process.getuid?.() ?? "user"}.lock`);
const defaultJournalPath = (): string =>
  join(homedir(), ".cache", "pi-harness", "pi-update-recovery.json");

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
    if (
      value.schema !== "pi-harness/update-recovery" ||
      value.version !== 1 ||
      typeof value.packageName !== "string" ||
      typeof value.previousVersion !== "string" ||
      typeof value.previousSignature !== "string" ||
      !Array.isArray(value.rollbackArgv) ||
      value.rollbackArgv.some((item) => typeof item !== "string") ||
      value.rollbackArgv.length !== 5 ||
      !isAbsolute(value.rollbackArgv[0] ?? "") ||
      value.rollbackArgv[1] !== "install" ||
      value.rollbackArgv[2] !== "-g" ||
      value.rollbackArgv[3] !== "--ignore-scripts" ||
      value.rollbackArgv[4] !== `${value.packageName}@${value.previousVersion}`
    ) {
      throw new Error("invalid pi update recovery journal");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
      message: `automatic rollback failed: ${result.stderr || result.stdout}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
  try {
    const restored = await dependencies.checkCompatibility();
    if (restored.installation.packageVersion !== journal.previousVersion) {
      throw new Error(
        `restored version ${restored.installation.packageVersion} != ${journal.previousVersion}`,
      );
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
      message: `rollback installed but verification failed: ${String(error)}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
};

export const updatePiSafely = async (
  dependencies: UpdatePiDependencies,
): Promise<UpdatePiResult> => {
  const run = dependencies.run ?? runCommand;
  const lockPath = dependencies.lockPath ?? defaultLockPath();
  const journalPath = dependencies.journalPath ?? defaultJournalPath();
  const lock = await acquireUpdateLock(lockPath, dependencies.pid);
  try {
    const unfinished = await readJournal(journalPath);
    if (unfinished !== undefined) {
      try {
        const current = await dependencies.discover();
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

    // Establish a known-good rollback target before any global mutation.
    const preflight = await dependencies.checkCompatibility();
    const previous = preflight.installation;
    const rollbackArgv = [
      previous.bunExecutable,
      "install",
      "-g",
      "--ignore-scripts",
      `${previous.packageName}@${previous.packageVersion}`,
    ];
    const journal: RecoveryJournal = {
      schema: "pi-harness/update-recovery",
      version: 1,
      createdAt: new Date().toISOString(),
      packageName: previous.packageName,
      previousVersion: previous.packageVersion,
      previousSignature: installationSignature(previous),
      rollbackArgv,
    };
    await writeJournal(journalPath, journal);

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
