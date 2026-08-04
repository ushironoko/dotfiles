import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface LocalConfigMutation<T> {
  readonly changed: boolean;
  readonly value: T;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const isExistingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "EEXIST";

const LOCK_STALE_MS = 5 * 60 * 1_000;

const writableConfigPath = (configFile: string): string => {
  let symbolicLink: boolean;
  try {
    symbolicLink = lstatSync(configFile).isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) return configFile;
    throw error;
  }
  // Never replace the machine-local symlink itself. A dangling link fails
  // closed instead of silently becoming a regular config file.
  return symbolicLink ? realpathSync(configFile) : configFile;
};

export const readLocalConfig = (
  configFile: string,
): { root: Record<string, unknown>; raw: string | undefined } => {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { root: {}, raw: undefined };
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("pi-harness.local.json must contain an object");
  }
  return { root: parsed, raw };
};

const currentRaw = (configFile: string): string | undefined => {
  try {
    return readFileSync(configFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
};

const releaseLock = (lockFile: string, token: string): void => {
  try {
    if (readFileSync(lockFile, "utf8") === token) unlinkSync(lockFile);
  } catch {
    // Best-effort cleanup must not mask the update result. A missing or
    // replaced lock is never unlinked on behalf of another writer.
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
};

const lockOwnerPid = (token: string): number | undefined => {
  const match = /^(\d+):[0-9a-f-]+$/.exec(token);
  if (match?.[1] === undefined) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const recoverOrphanedLock = (lockFile: string): boolean => {
  try {
    const before = lstatSync(lockFile);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    const token = readFileSync(lockFile, "utf8");
    const ownerPid = lockOwnerPid(token);
    const expired = Date.now() - before.mtimeMs >= LOCK_STALE_MS;
    if (!expired && (ownerPid === undefined || processIsAlive(ownerPid))) {
      return false;
    }

    // Recheck identity and contents immediately before unlinking so a writer
    // that replaced the observed orphan is not removed on its behalf.
    const after = lstatSync(lockFile);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      readFileSync(lockFile, "utf8") !== token
    ) {
      return false;
    }
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
};

/**
 * Serializes pi-harness writers around one complete read-modify-rename cycle.
 * The byte comparison additionally catches editors that do not honor the lock.
 */
export const updateLocalConfig = <T>(
  configFile: string,
  mutate: (root: Record<string, unknown>) => LocalConfigMutation<T>,
): T => {
  const target = writableConfigPath(configFile);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const lockFile = join(directory, `.${basename(target)}.lock`);
  const lockToken = `${process.pid}:${randomUUID()}`;
  let lockCreated = false;
  for (let attempt = 0; attempt < 2 && !lockCreated; attempt += 1) {
    try {
      writeFileSync(lockFile, lockToken, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      lockCreated = true;
      chmodSync(lockFile, 0o600);
    } catch (error) {
      if (lockCreated) {
        releaseLock(lockFile, lockToken);
        throw error;
      }
      if (
        !isExistingFile(error) ||
        attempt > 0 ||
        !recoverOrphanedLock(lockFile)
      ) {
        if (isExistingFile(error)) {
          throw new Error("pi-harness.local.json update already in progress");
        }
        throw error;
      }
    }
  }

  try {
    const { root, raw } = readLocalConfig(target);
    const mutation = mutate(root);
    if (!mutation.changed) return mutation.value;

    const temporary = join(
      directory,
      `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let mode = 0o600;
    try {
      mode = statSync(target).mode & 0o777;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const removeTemporary = (): void => {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup must not mask the original write failure.
      }
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode,
      });
      // writeFile's mode is filtered by umask; restore the exact saved mode
      // before publishing the replacement.
      chmodSync(temporary, mode);
      if (currentRaw(target) !== raw) {
        throw new Error(
          "pi-harness.local.json changed concurrently; update was not applied",
        );
      }
      renameSync(temporary, target);
    } catch (error) {
      removeTemporary();
      throw error;
    }
    removeTemporary();
    return mutation.value;
  } finally {
    releaseLock(lockFile, lockToken);
  }
};
