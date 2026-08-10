import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { PI_BASELINE_PACKAGES } from "./baseline";
import type { PiCompatibilityResult } from "./index";
import type { PiInstallation } from "./installation";
import { runCommand, type CommandResult, type CommandRunner } from "./process";

export interface RecoveryPackageSnapshot {
  packageName: string;
  packageRoot: string;
  digest: string | null;
}

export interface RecoveryMetadataSnapshot {
  name: GlobalMetadataName;
  path: string;
  digest: string | null;
}

export interface RecoveryGlobalBinSnapshot {
  name: GlobalBinName;
  path: string;
  digest: string | null;
}

export interface RecoveryInventorySnapshot {
  packageName: string;
  packageRoot: string;
  digest: string;
}

export interface RecoverySnapshotManifest {
  transactionId: string;
  packages: RecoveryPackageSnapshot[];
  metadata: RecoveryMetadataSnapshot[];
  globalBins: RecoveryGlobalBinSnapshot[];
  packageInventory: RecoveryInventorySnapshot[];
}

interface RecoveryJournal {
  schema: "pi-harness/update-recovery";
  version: 6;
  createdAt: string;
  packageName: string;
  previousVersion: string;
  previousSignature: string;
  candidatePackages: string[];
  rollbackArgv: string[];
  rollbackPackages: string[];
  rollbackExecutableDigest: string;
  snapshots: RecoverySnapshotManifest;
}

export interface UpdatePiSnapshotStore {
  create(
    installation: PiInstallation,
    journalPath: string,
    candidatePackageNames: string[],
  ): Promise<RecoverySnapshotManifest>;
  validate(
    journalPath: string,
    snapshots: RecoverySnapshotManifest,
  ): Promise<void>;
  restoreMetadata(
    journalPath: string,
    snapshots: RecoverySnapshotManifest,
    installation: Pick<
      PiInstallation,
      "globalBin" | "packageName" | "packageRoot"
    >,
  ): Promise<void>;
  restore(
    journalPath: string,
    snapshots: RecoverySnapshotManifest,
    installation: PiInstallation,
  ): Promise<void>;
  unrelatedStateMatches(
    journalPath: string,
    snapshots: RecoverySnapshotManifest,
  ): Promise<boolean>;
  matches(snapshots: RecoverySnapshotManifest): Promise<boolean>;
  cleanup(snapshots: RecoverySnapshotManifest): Promise<void>;
  sync(snapshots: RecoverySnapshotManifest): Promise<void>;
  remove(journalPath: string): Promise<void>;
}

export interface UpdatePiDependencies {
  checkCompatibility(): Promise<PiCompatibilityResult>;
  discover(): Promise<PiInstallation>;
  run?: CommandRunner;
  snapshotStore?: UpdatePiSnapshotStore;
  executableDigest?(path: string): Promise<string>;
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

    const generation = createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 16);
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
): Promise<UpdateLock> =>
  acquireUpdateLockInternal(path, pid, 0, path, testSeams);

export const defaultUpdateLockPath = (): string =>
  join(tmpdir(), `pi-harness-update-${process.getuid?.() ?? "user"}.lock`);
export const defaultUpdateJournalPath = (): string =>
  join(homedir(), ".cache", "pi-harness", "pi-update-recovery.json");

const snapshotRootPath = (journalPath: string): string =>
  `${journalPath}.packages`;
const snapshotTemporaryPath = (journalPath: string): string =>
  `${snapshotRootPath(journalPath)}.tmp`;
const globalMetadataNames = [
  "bun.lock",
  "bun.lockb",
  "node_modules/.bin",
  "package.json",
] as const;
type GlobalMetadataName = (typeof globalMetadataNames)[number];
type GlobalBinName = "pi" | "pi-ai" | "pi-ai.exe" | "pi.exe";

const globalBinNames: readonly GlobalBinName[] =
  process.platform === "win32" ? ["pi.exe", "pi-ai.exe"] : ["pi", "pi-ai"];

const metadataSnapshotType = (name: GlobalMetadataName): SnapshotEntryType =>
  name === "node_modules/.bin" ? "directory" : "file";

const snapshotEntryPath = (
  journalPath: string,
  category: "global-bin" | "metadata" | "packages",
  key: string,
): string =>
  join(
    snapshotRootPath(journalPath),
    category,
    createHash("sha256").update(key).digest("hex"),
  );

const snapshotPackagePath = (
  journalPath: string,
  packageName: string,
): string => snapshotEntryPath(journalPath, "packages", packageName);

const snapshotMetadataPath = (
  journalPath: string,
  name: GlobalMetadataName,
): string => snapshotEntryPath(journalPath, "metadata", name);

const snapshotGlobalBinPath = (
  journalPath: string,
  name: GlobalBinName,
): string => snapshotEntryPath(journalPath, "global-bin", name);

const updateDigestField = (
  hash: ReturnType<typeof createHash>,
  value: string,
): void => {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
};

const executableFileDigest = async (path: string): Promise<string> => {
  const stats = await stat(path);
  if (
    !stats.isFile() ||
    (process.platform !== "win32" && (stats.mode & 0o111) === 0)
  ) {
    throw new Error("captured Bun executable is not an executable file");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
};

const packageTreeDigest = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  const visit = async (relativePath: string): Promise<void> => {
    const path = relativePath === "" ? root : join(root, relativePath);
    const stats = await lstat(path);
    const mode = (stats.mode & 0o777).toString(8);
    if (stats.isDirectory()) {
      updateDigestField(hash, `directory:${mode}`);
      updateDigestField(hash, relativePath);
      const directoryEntries = await readdir(path);
      const entries = directoryEntries.sort((left, right) =>
        left.localeCompare(right),
      );
      for (const entry of entries) {
        await visit(relativePath === "" ? entry : join(relativePath, entry));
      }
      return;
    }
    if (stats.isSymbolicLink()) {
      updateDigestField(hash, `symlink:${mode}`);
      updateDigestField(hash, relativePath);
      updateDigestField(hash, await readlink(path));
      return;
    }
    if (!stats.isFile()) {
      throw new Error(`unsupported package snapshot entry: ${path}`);
    }
    updateDigestField(hash, `file:${mode}`);
    updateDigestField(hash, relativePath);
    updateDigestField(hash, String(stats.size));
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
  };
  await visit("");
  return hash.digest("hex");
};

const pathIsAbsent = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

type SnapshotEntryType = "directory" | "executable" | "file";

const assertSnapshotEntryType = async (
  path: string,
  expectedType: SnapshotEntryType,
  label: string,
): Promise<void> => {
  const stats = await lstat(path);
  let matches: boolean;
  switch (expectedType) {
    case "directory": {
      matches = stats.isDirectory();
      break;
    }
    case "executable": {
      matches = stats.isFile() || stats.isSymbolicLink();
      break;
    }
    case "file": {
      matches = stats.isFile();
      break;
    }
  }
  if (!matches) {
    throw new Error(`rollback ${label} is not a ${expectedType}`);
  }
};

const syncPath = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const ensureDirectoryDurable = async (
  path: string,
  mode = 0o700,
): Promise<void> => {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      throw new Error(`recovery path is not a directory: ${path}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) {
    throw new Error(`recovery directory has no durable parent: ${path}`);
  }
  await ensureDirectoryDurable(parent, mode);
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      throw new Error(`recovery path is not a directory: ${path}`);
    }
  }
  await syncPath(path);
  await syncPath(parent);
};

const syncTree = async (root: string): Promise<void> => {
  const stats = await lstat(root);
  if (stats.isDirectory()) {
    for (const entry of await readdir(root)) {
      await syncTree(join(root, entry));
    }
    await syncPath(root);
    return;
  }
  if (stats.isFile()) {
    await syncPath(root);
    return;
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`unsupported snapshot entry while syncing: ${root}`);
  }
};

const captureSnapshotEntry = async (
  source: string,
  destination: string,
  expectedType: SnapshotEntryType,
): Promise<string | null> => {
  try {
    await assertSnapshotEntryType(source, expectedType, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const digest = await packageTreeDigest(source);
  await mkdir(dirname(destination), { mode: 0o700, recursive: true });
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await assertSnapshotEntryType(destination, expectedType, source);
  if ((await packageTreeDigest(destination)) !== digest) {
    throw new Error(`snapshot verification failed: ${source}`);
  }
  return digest;
};

const validateSnapshotEntry = async (
  source: string,
  digest: string | null,
  label: string,
  expectedType: SnapshotEntryType,
): Promise<void> => {
  if (digest === null) {
    if (!(await pathIsAbsent(source))) {
      throw new Error(`unexpected rollback snapshot for absent ${label}`);
    }
    return;
  }
  await assertSnapshotEntryType(source, expectedType, label);
  if ((await packageTreeDigest(source)) !== digest) {
    throw new Error(`rollback snapshot digest mismatch: ${label}`);
  }
};

const rollbackReplacementPath = (
  target: string,
  transactionId: string,
): string =>
  join(
    dirname(target),
    `.${basename(target)}.pi-harness-rollback-${transactionId}.tmp`,
  );

const restoreSnapshotEntry = async (
  source: string,
  target: string,
  digest: string | null,
  label: string,
  expectedType: SnapshotEntryType,
  transactionId: string,
): Promise<void> => {
  await validateSnapshotEntry(source, digest, label, expectedType);
  if (digest === null) {
    await rm(target, { force: true, recursive: true });
    await syncPath(dirname(target));
    if (!(await pathIsAbsent(target))) {
      throw new Error(`rollback failed to remove preflight-absent ${label}`);
    }
    return;
  }
  const replacement = rollbackReplacementPath(target, transactionId);
  await rm(replacement, { force: true, recursive: true });
  try {
    await mkdir(dirname(replacement), { mode: 0o700, recursive: true });
    await cp(source, replacement, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await assertSnapshotEntryType(replacement, expectedType, label);
    if ((await packageTreeDigest(replacement)) !== digest) {
      throw new Error(`rollback replacement verification failed: ${label}`);
    }
    await syncTree(replacement);
    await rm(target, { force: true, recursive: true });
    await rename(replacement, target);
    await syncPath(dirname(target));
    await assertSnapshotEntryType(target, expectedType, label);
    if ((await packageTreeDigest(target)) !== digest) {
      throw new Error(`rollback restored digest mismatch: ${label}`);
    }
  } finally {
    await rm(replacement, { force: true, recursive: true }).catch(
      () => undefined,
    );
    await syncPath(dirname(replacement));
  }
};

const snapshotEntryMatches = async (
  target: string,
  digest: string | null,
  expectedType: SnapshotEntryType,
): Promise<boolean> => {
  try {
    if (digest === null) return await pathIsAbsent(target);
    await assertSnapshotEntryType(target, expectedType, target);
    return (await packageTreeDigest(target)) === digest;
  } catch {
    return false;
  }
};

const packageRootForName = (
  installation: Pick<PiInstallation, "packageName" | "packageRoot">,
  packageName: string,
): string =>
  join(
    nodeModulesRootForPackage(
      installation.packageRoot,
      installation.packageName,
    ),
    ...packageName.split("/"),
  );

const globalRootForInstallation = (
  installation: Pick<PiInstallation, "packageName" | "packageRoot">,
): string =>
  dirname(
    nodeModulesRootForPackage(
      installation.packageRoot,
      installation.packageName,
    ),
  );

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const scanPackageInventory = async (
  installation: Pick<PiInstallation, "packageName" | "packageRoot">,
): Promise<RecoveryInventorySnapshot[]> => {
  const modulesRoot = nodeModulesRootForPackage(
    installation.packageRoot,
    installation.packageName,
  );
  const packageNames: string[] = [];
  const moduleEntries = await readdir(modulesRoot);
  moduleEntries.sort((left, right) => left.localeCompare(right));
  for (const entry of moduleEntries) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    const entryPath = join(modulesRoot, entry);
    const entryStats = await lstat(entryPath);
    if (entry.startsWith("@")) {
      if (!entryStats.isDirectory()) {
        throw new Error(`global package scope is not a directory: ${entry}`);
      }
      const scopeEntries = await readdir(entryPath);
      scopeEntries.sort((left, right) => left.localeCompare(right));
      for (const child of scopeEntries) {
        const packageName = `${entry}/${child}`;
        const childStats = await lstat(join(entryPath, child));
        if (
          packageNamePattern.test(packageName) &&
          (childStats.isDirectory() || childStats.isSymbolicLink())
        ) {
          packageNames.push(packageName);
        }
      }
      continue;
    }
    if (
      packageNamePattern.test(entry) &&
      (entryStats.isDirectory() || entryStats.isSymbolicLink())
    ) {
      packageNames.push(entry);
    }
  }
  packageNames.sort((left, right) => left.localeCompare(right));
  return Promise.all(
    packageNames.map(async (packageName) => {
      const packageRoot = join(modulesRoot, ...packageName.split("/"));
      return {
        packageName,
        packageRoot,
        digest: await packageTreeDigest(packageRoot),
      };
    }),
  );
};

const inventoryInstallation = (
  snapshots: RecoverySnapshotManifest,
): Pick<PiInstallation, "packageName" | "packageRoot"> => {
  const top = snapshots.packages.find(
    ({ packageName }) => packageName === "@earendil-works/pi-coding-agent",
  );
  if (top === undefined) {
    throw new Error("recovery snapshots omit the Pi coding agent");
  }
  return { packageName: top.packageName, packageRoot: top.packageRoot };
};

const restoreMetadataSnapshots = async (
  journalPath: string,
  snapshots: RecoverySnapshotManifest,
  installation: Pick<
    PiInstallation,
    "globalBin" | "packageName" | "packageRoot"
  >,
): Promise<void> => {
  const globalRoot = globalRootForInstallation(installation);
  for (const snapshot of snapshots.metadata) {
    if (snapshot.path !== join(globalRoot, snapshot.name)) {
      throw new Error(`rollback metadata root mismatch: ${snapshot.name}`);
    }
    await restoreSnapshotEntry(
      snapshotMetadataPath(journalPath, snapshot.name),
      snapshot.path,
      snapshot.digest,
      snapshot.name,
      metadataSnapshotType(snapshot.name),
      snapshots.transactionId,
    );
  }
  for (const snapshot of snapshots.globalBins) {
    if (snapshot.path !== join(installation.globalBin, snapshot.name)) {
      throw new Error(`rollback global bin root mismatch: ${snapshot.name}`);
    }
    await restoreSnapshotEntry(
      snapshotGlobalBinPath(journalPath, snapshot.name),
      snapshot.path,
      snapshot.digest,
      snapshot.name,
      "executable",
      snapshots.transactionId,
    );
  }
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
};

const unrelatedGlobalMetadata = async (path: string): Promise<string> => {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const value = recordValue(parsed);
  if (value === undefined)
    throw new Error("global package metadata is invalid");
  const copy: Record<string, unknown> = { ...value };
  for (const sectionName of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const section = recordValue(copy[sectionName]);
    if (section === undefined) continue;
    copy[sectionName] = Object.fromEntries(
      Object.entries(section).filter(([name]) => !piPackageNameSet.has(name)),
    );
  }
  return JSON.stringify(canonicalJsonValue(copy));
};

const recoveryInstallation = (
  snapshots: RecoverySnapshotManifest,
): Pick<PiInstallation, "globalBin" | "packageName" | "packageRoot"> => {
  const installation = inventoryInstallation(snapshots);
  const [firstBin] = snapshots.globalBins;
  if (firstBin === undefined) {
    throw new Error("recovery snapshots omit the Bun global bin");
  }
  const globalBin = dirname(firstBin.path);
  if (snapshots.globalBins.some(({ path }) => dirname(path) !== globalBin)) {
    throw new Error("recovery global bin snapshots disagree on their root");
  }
  return { ...installation, globalBin };
};

const syncRecoveredState = async (
  snapshots: RecoverySnapshotManifest,
): Promise<void> => {
  const installation = recoveryInstallation(snapshots);
  const inventory = await scanPackageInventory(installation);
  for (const snapshot of inventory) {
    await syncTree(snapshot.packageRoot);
    await syncPath(dirname(snapshot.packageRoot));
  }
  for (const snapshot of [...snapshots.metadata, ...snapshots.globalBins]) {
    if (await pathIsAbsent(snapshot.path)) {
      await syncPath(dirname(snapshot.path));
    } else {
      await syncTree(snapshot.path);
      await syncPath(dirname(snapshot.path));
    }
  }
  const modulesRoot = nodeModulesRootForPackage(
    installation.packageRoot,
    installation.packageName,
  );
  await syncPath(modulesRoot);
  await syncPath(dirname(modulesRoot));
  await syncPath(installation.globalBin);
};

const fileSystemSnapshotStore: UpdatePiSnapshotStore = {
  async create(installation, journalPath, candidatePackageNames) {
    const root = snapshotRootPath(journalPath);
    const temporary = snapshotTemporaryPath(journalPath);
    await ensureDirectoryDurable(dirname(root));
    await rm(root, { force: true, recursive: true });
    await rm(temporary, { force: true, recursive: true });
    await mkdir(temporary, { mode: 0o700 });
    const snapshots: RecoverySnapshotManifest = {
      transactionId: randomUUID(),
      packages: [],
      metadata: [],
      globalBins: [],
      packageInventory: [],
    };
    try {
      const globalRoot = globalRootForInstallation(installation);
      const packageJsonPath = join(globalRoot, "package.json");
      await assertSnapshotEntryType(
        packageJsonPath,
        "file",
        "global package.json",
      );
      await unrelatedGlobalMetadata(packageJsonPath);
      snapshots.packageInventory = await scanPackageInventory(installation);
      const packageNames = [
        ...new Set([
          ...Object.keys(installation.corePackages),
          ...candidatePackageNames,
        ]),
      ].sort((left, right) => left.localeCompare(right));
      for (const packageName of packageNames) {
        const packageRoot = packageRootForName(installation, packageName);
        const discovered = installation.corePackages[packageName];
        if (discovered !== undefined && discovered.root !== packageRoot) {
          throw new Error(`Pi package root is not canonical: ${packageName}`);
        }
        const destination = join(
          temporary,
          "packages",
          createHash("sha256").update(packageName).digest("hex"),
        );
        const digest = await captureSnapshotEntry(
          packageRoot,
          destination,
          "directory",
        );
        if (discovered !== undefined && digest === null) {
          throw new Error(`discovered Pi package is absent: ${packageName}`);
        }
        snapshots.packages.push({ packageName, packageRoot, digest });
      }

      for (const name of globalMetadataNames) {
        const path = join(globalRoot, name);
        const destination = join(
          temporary,
          "metadata",
          createHash("sha256").update(name).digest("hex"),
        );
        const digest = await captureSnapshotEntry(
          path,
          destination,
          metadataSnapshotType(name),
        );
        snapshots.metadata.push({ name, path, digest });
      }
      for (const name of globalBinNames) {
        const path = join(installation.globalBin, name);
        const destination = join(
          temporary,
          "global-bin",
          createHash("sha256").update(name).digest("hex"),
        );
        const digest = await captureSnapshotEntry(
          path,
          destination,
          "executable",
        );
        snapshots.globalBins.push({ name, path, digest });
      }
      await syncTree(temporary);
      await rename(temporary, root);
      await syncPath(dirname(root));
      return snapshots;
    } catch (error) {
      await rm(temporary, { force: true, recursive: true }).catch(
        () => undefined,
      );
      throw error;
    }
  },
  async validate(journalPath, snapshots) {
    for (const snapshot of snapshots.packages) {
      await validateSnapshotEntry(
        snapshotPackagePath(journalPath, snapshot.packageName),
        snapshot.digest,
        snapshot.packageName,
        "directory",
      );
    }
    for (const snapshot of snapshots.metadata) {
      await validateSnapshotEntry(
        snapshotMetadataPath(journalPath, snapshot.name),
        snapshot.digest,
        snapshot.name,
        metadataSnapshotType(snapshot.name),
      );
    }
    for (const snapshot of snapshots.globalBins) {
      await validateSnapshotEntry(
        snapshotGlobalBinPath(journalPath, snapshot.name),
        snapshot.digest,
        snapshot.name,
        "executable",
      );
    }
  },
  async restoreMetadata(journalPath, snapshots, installation) {
    await restoreMetadataSnapshots(journalPath, snapshots, installation);
  },
  async restore(journalPath, snapshots, installation) {
    for (const snapshot of snapshots.packages) {
      const expectedRoot = packageRootForName(
        installation,
        snapshot.packageName,
      );
      if (expectedRoot !== snapshot.packageRoot) {
        throw new Error(
          `rollback package root mismatch: ${snapshot.packageName}`,
        );
      }
      await restoreSnapshotEntry(
        snapshotPackagePath(journalPath, snapshot.packageName),
        snapshot.packageRoot,
        snapshot.digest,
        snapshot.packageName,
        "directory",
        snapshots.transactionId,
      );
    }
    await restoreMetadataSnapshots(journalPath, snapshots, installation);
  },
  async unrelatedStateMatches(journalPath, snapshots) {
    const packageJson = snapshots.metadata.find(
      ({ name }) => name === "package.json",
    );
    if (packageJson?.digest === null || packageJson === undefined) return false;
    try {
      return (
        (await unrelatedGlobalMetadata(
          snapshotMetadataPath(journalPath, packageJson.name),
        )) === (await unrelatedGlobalMetadata(packageJson.path))
      );
    } catch {
      return false;
    }
  },
  async matches(snapshots) {
    for (const snapshot of snapshots.packages) {
      if (
        !(await snapshotEntryMatches(
          snapshot.packageRoot,
          snapshot.digest,
          "directory",
        ))
      ) {
        return false;
      }
    }
    for (const snapshot of snapshots.metadata) {
      if (
        !(await snapshotEntryMatches(
          snapshot.path,
          snapshot.digest,
          metadataSnapshotType(snapshot.name),
        ))
      ) {
        return false;
      }
    }
    for (const snapshot of snapshots.globalBins) {
      if (
        !(await snapshotEntryMatches(
          snapshot.path,
          snapshot.digest,
          "executable",
        ))
      ) {
        return false;
      }
    }
    const installation = inventoryInstallation(snapshots);
    const inventory = await scanPackageInventory(installation).catch(
      () => undefined,
    );
    if (
      inventory === undefined ||
      inventory.length !== snapshots.packageInventory.length ||
      inventory.some((snapshot, index) => {
        const expected = snapshots.packageInventory[index];
        return (
          expected === undefined ||
          snapshot.packageName !== expected.packageName ||
          snapshot.packageRoot !== expected.packageRoot ||
          snapshot.digest !== expected.digest
        );
      })
    ) {
      return false;
    }
    return true;
  },
  async cleanup(snapshots) {
    for (const snapshot of [
      ...snapshots.packages,
      ...snapshots.metadata,
      ...snapshots.globalBins,
    ]) {
      const target =
        "packageRoot" in snapshot ? snapshot.packageRoot : snapshot.path;
      await rm(rollbackReplacementPath(target, snapshots.transactionId), {
        force: true,
        recursive: true,
      });
      await syncPath(dirname(target));
    }
  },
  async sync(snapshots) {
    await syncRecoveredState(snapshots);
  },
  async remove(journalPath) {
    await Promise.all([
      rm(snapshotRootPath(journalPath), { force: true, recursive: true }),
      rm(snapshotTemporaryPath(journalPath), {
        force: true,
        recursive: true,
      }),
    ]);
    await syncPath(dirname(snapshotRootPath(journalPath)));
  },
};

const packageVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const piPackageNameSet = new Set<string>(PI_BASELINE_PACKAGES);
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
  globalBin: string;
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
    typeof value.globalBin !== "string" ||
    !isAbsolute(value.globalBin) ||
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
    globalBin: value.globalBin,
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
  return (
    value.rollbackPackages.length === expectedPackages.length &&
    value.rollbackPackages.every(
      (item, index) =>
        validPackageSpec(item) && item === expectedPackages[index],
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
  await ensureDirectoryDurable(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
    });
    await syncPath(temporary);
    await rename(temporary, path);
    await syncPath(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const digestPattern = /^[a-f0-9]{64}$/;
const transactionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const packageNameFromSpec = (spec: string): string =>
  spec.slice(0, spec.lastIndexOf("@"));

const parseCandidatePackages = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const packages: string[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !validPackageSpec(item)) return undefined;
    const name = packageNameFromSpec(item);
    if (!piPackageNameSet.has(name) || names.has(name)) return undefined;
    names.add(name);
    packages.push(item);
  }
  return packages;
};

const validSnapshotDigest = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && digestPattern.test(value));

const parsePackageSnapshots = (
  value: unknown,
  signature: RecordedSignature,
  candidatePackages: string[],
): RecoveryPackageSnapshot[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  let expectedRootByName: Map<string, string>;
  try {
    const names = new Set([
      ...Object.keys(signature.core),
      ...candidatePackages.map(packageNameFromSpec),
    ]);
    expectedRootByName = new Map(
      [...names]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => [
          name,
          packageRootForName(
            {
              packageName: signature.packageName,
              packageRoot: signature.packageRoot,
            },
            name,
          ),
        ]),
    );
  } catch {
    return undefined;
  }
  if (value.length !== expectedRootByName.size) return undefined;
  const snapshots: RecoveryPackageSnapshot[] = [];
  let index = 0;
  for (const [expectedName, expectedRoot] of expectedRootByName) {
    const item = recordValue(value[index]);
    const corePackage = signature.core[expectedName];
    if (
      item === undefined ||
      item.packageName !== expectedName ||
      item.packageRoot !== expectedRoot ||
      (corePackage !== undefined && corePackage.root !== expectedRoot) ||
      !validSnapshotDigest(item.digest) ||
      (corePackage !== undefined && item.digest === null)
    ) {
      return undefined;
    }
    snapshots.push({
      packageName: expectedName,
      packageRoot: expectedRoot,
      digest: item.digest,
    });
    index += 1;
  }
  return snapshots;
};

const parseMetadataSnapshots = (
  value: unknown,
  signature: RecordedSignature,
): RecoveryMetadataSnapshot[] | undefined => {
  if (!Array.isArray(value) || value.length !== globalMetadataNames.length) {
    return undefined;
  }
  let globalRoot: string;
  try {
    globalRoot = globalRootForInstallation({
      packageName: signature.packageName,
      packageRoot: signature.packageRoot,
    });
  } catch {
    return undefined;
  }
  const snapshots: RecoveryMetadataSnapshot[] = [];
  for (let index = 0; index < globalMetadataNames.length; index += 1) {
    const name = globalMetadataNames[index];
    const item = recordValue(value[index]);
    const path = join(globalRoot, name);
    if (
      item === undefined ||
      item.name !== name ||
      item.path !== path ||
      !validSnapshotDigest(item.digest)
    ) {
      return undefined;
    }
    snapshots.push({ name, path, digest: item.digest });
  }
  return snapshots;
};

const parseGlobalBinSnapshots = (
  value: unknown,
  signature: RecordedSignature,
): RecoveryGlobalBinSnapshot[] | undefined => {
  if (!Array.isArray(value) || value.length !== globalBinNames.length) {
    return undefined;
  }
  const snapshots: RecoveryGlobalBinSnapshot[] = [];
  for (let index = 0; index < globalBinNames.length; index += 1) {
    const name = globalBinNames[index];
    const item = recordValue(value[index]);
    const path = join(signature.globalBin, name);
    if (
      item === undefined ||
      item.name !== name ||
      item.path !== path ||
      !validSnapshotDigest(item.digest)
    ) {
      return undefined;
    }
    snapshots.push({ name, path, digest: item.digest });
  }
  return snapshots;
};

const parsePackageInventory = (
  value: unknown,
  signature: RecordedSignature,
): RecoveryInventorySnapshot[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) {
    return undefined;
  }
  let modulesRoot: string;
  try {
    modulesRoot = nodeModulesRootForPackage(
      signature.packageRoot,
      signature.packageName,
    );
  } catch {
    return undefined;
  }
  const inventory: RecoveryInventorySnapshot[] = [];
  let previous: string | undefined;
  for (const rawItem of value) {
    const item = recordValue(rawItem);
    if (
      item === undefined ||
      typeof item.packageName !== "string" ||
      !packageNamePattern.test(item.packageName) ||
      (previous !== undefined &&
        previous.localeCompare(item.packageName) >= 0) ||
      item.packageRoot !== join(modulesRoot, ...item.packageName.split("/")) ||
      typeof item.digest !== "string" ||
      !digestPattern.test(item.digest)
    ) {
      return undefined;
    }
    inventory.push({
      packageName: item.packageName,
      packageRoot: item.packageRoot,
      digest: item.digest,
    });
    previous = item.packageName;
  }
  if (
    Object.keys(signature.core).some(
      (name) => !inventory.some(({ packageName }) => packageName === name),
    )
  ) {
    return undefined;
  }
  return inventory;
};

const readJournal = async (
  path: string,
): Promise<RecoveryJournal | undefined> => {
  try {
    const value = recordValue(JSON.parse(await readFile(path, "utf8")));
    if (value === undefined) {
      throw new Error("invalid pi update recovery journal");
    }
    if (
      value.version === 1 &&
      Object.hasOwn(value, "restorePatches") &&
      typeof value.restorePatches === "boolean"
    ) {
      throw new Error(
        "legacy pi update recovery journal contains patch restoration state; automatic recovery is disabled because the patch mechanism was removed; journal retained for manual recovery",
      );
    }
    if (value.version === 2) {
      throw new Error(
        "legacy pi update recovery journal lacks package-content snapshots; automatic recovery is disabled; journal retained for manual recovery",
      );
    }
    if (value.version === 3) {
      throw new Error(
        "legacy pi update recovery journal lacks global install metadata and absent-package snapshots; automatic recovery is disabled; journal retained for manual recovery",
      );
    }
    if (value.version === 4) {
      throw new Error(
        "legacy pi update recovery journal lacks the complete global package inventory and executable-link snapshot; automatic recovery is disabled; journal retained for manual recovery",
      );
    }
    if (value.version === 5) {
      throw new Error(
        "legacy pi update recovery journal lacks actual global-bin state, inventory content digests, and collision-free transaction staging; automatic recovery is disabled; journal retained for manual recovery",
      );
    }
    const signature =
      typeof value.previousSignature === "string"
        ? parseRecordedSignature(value.previousSignature)
        : undefined;
    const candidatePackages = parseCandidatePackages(value.candidatePackages);
    const snapshotsValue = recordValue(value.snapshots);
    const { rollbackArgv, rollbackPackages, rollbackExecutableDigest } = value;
    const packageSnapshots =
      signature === undefined || candidatePackages === undefined
        ? undefined
        : parsePackageSnapshots(
            snapshotsValue?.packages,
            signature,
            candidatePackages,
          );
    const metadataSnapshots =
      signature === undefined
        ? undefined
        : parseMetadataSnapshots(snapshotsValue?.metadata, signature);
    const globalBinSnapshots =
      signature === undefined
        ? undefined
        : parseGlobalBinSnapshots(snapshotsValue?.globalBins, signature);
    const packageInventory =
      signature === undefined
        ? undefined
        : parsePackageInventory(snapshotsValue?.packageInventory, signature);
    const transactionId = snapshotsValue?.transactionId;
    if (
      value.schema !== "pi-harness/update-recovery" ||
      value.version !== 6 ||
      Object.hasOwn(value, "restorePatches") ||
      typeof value.createdAt !== "string" ||
      typeof value.packageName !== "string" ||
      typeof value.previousVersion !== "string" ||
      typeof value.previousSignature !== "string" ||
      signature === undefined ||
      signature.packageName !== "@earendil-works/pi-coding-agent" ||
      signature.packageName !== value.packageName ||
      signature.packageVersion !== value.previousVersion ||
      candidatePackages === undefined ||
      !candidatePackages.some(
        (item) => packageNameFromSpec(item) === signature.packageName,
      ) ||
      !Array.isArray(rollbackArgv) ||
      !rollbackArgv.every((item): item is string => typeof item === "string") ||
      !Array.isArray(rollbackPackages) ||
      !rollbackPackages.every(
        (item): item is string => typeof item === "string",
      ) ||
      typeof rollbackExecutableDigest !== "string" ||
      !digestPattern.test(rollbackExecutableDigest) ||
      packageSnapshots === undefined ||
      metadataSnapshots === undefined ||
      globalBinSnapshots === undefined ||
      packageInventory === undefined ||
      typeof transactionId !== "string" ||
      !transactionIdPattern.test(transactionId)
    ) {
      throw new Error("invalid pi update recovery journal");
    }
    const journal: RecoveryJournal = {
      schema: value.schema,
      version: value.version,
      createdAt: value.createdAt,
      packageName: value.packageName,
      previousVersion: value.previousVersion,
      previousSignature: value.previousSignature,
      candidatePackages,
      rollbackArgv,
      rollbackPackages,
      rollbackExecutableDigest,
      snapshots: {
        transactionId,
        packages: packageSnapshots,
        metadata: metadataSnapshots,
        globalBins: globalBinSnapshots,
        packageInventory,
      },
    };
    const expectedPackages = packageSpecsFromSignature(signature);
    if (!validRollbackCommand(journal, expectedPackages)) {
      throw new Error("invalid pi update recovery journal");
    }
    return journal;
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
      "pi update recovery is pending; run `bun run update:pi` before changing the global Pi installation",
    );
  }
};

const successful = (result: CommandResult): boolean =>
  !result.timedOut && result.exitCode === 0;

const installationSignature = (installation: PiInstallation): string =>
  JSON.stringify({
    packageRoot: installation.packageRoot,
    globalBin: installation.globalBin,
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

const candidatePackageSpecs = (
  compatibility: PiCompatibilityResult,
  packageName: string,
): string[] => {
  const { packages } = compatibility.baseline;
  if (packages.length === 0 || packages.length > 64) {
    throw new Error("local Pi baseline has no valid candidate cohort");
  }
  const names = new Set<string>();
  const specs: string[] = [];
  for (const pkg of packages) {
    if (
      !piPackageNameSet.has(pkg.name) ||
      names.has(pkg.name) ||
      pkg.lockedVersion === undefined
    ) {
      throw new Error("local Pi baseline candidate cohort is incomplete");
    }
    const spec = `${pkg.name}@${pkg.lockedVersion}`;
    if (!validPackageSpec(spec)) {
      throw new Error(`invalid local Pi baseline candidate: ${spec}`);
    }
    names.add(pkg.name);
    specs.push(spec);
  }
  if (!names.has(packageName)) {
    throw new Error(`local Pi baseline omits ${packageName}`);
  }
  return specs;
};

const nodeModulesRootForPackage = (
  packageRoot: string,
  packageName: string,
): string => {
  let modulesRoot = packageRoot;
  for (const _segment of packageName.split("/")) {
    modulesRoot = dirname(modulesRoot);
  }
  if (
    basename(modulesRoot) !== "node_modules" ||
    join(modulesRoot, ...packageName.split("/")) !== packageRoot
  ) {
    throw new Error(`Pi package root is not canonical: ${packageRoot}`);
  }
  return modulesRoot;
};

const globalInstallEnvironment = (
  installation: Pick<
    RecordedSignature,
    "globalBin" | "packageName" | "packageRoot"
  >,
  bunExecutable: string,
): NodeJS.ProcessEnv => ({
  ...process.env,
  BUN_INSTALL_GLOBAL_DIR: dirname(
    nodeModulesRootForPackage(
      installation.packageRoot,
      installation.packageName,
    ),
  ),
  BUN_INSTALL_BIN: installation.globalBin,
  PATH: `${dirname(bunExecutable)}${delimiter}${process.env.PATH ?? ""}`,
});

const installationMatchesSpecs = (
  installation: PiInstallation,
  specs: string[],
): boolean => {
  if (Object.keys(installation.corePackages).length !== specs.length) {
    return false;
  }
  for (const spec of specs) {
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    if (installation.corePackages[name]?.version !== version) return false;
  }
  return true;
};

const manualRecoveryFollowUp =
  "recovery remains journaled; rerun `bun run update:pi` when Bun's registry/cache is available so the exact cohort, global package inventory, Pi executable entries, and Bun metadata are restored to their preflight state without a shell and verified";

const clearRecoveryState = async (
  journalPath: string,
  snapshotStore: UpdatePiSnapshotStore,
  snapshots: RecoverySnapshotManifest,
): Promise<void> => {
  // Recovery remains authoritative until restored/candidate state and cleanup
  // are durable. Only then persist the journal deletion; leftover snapshots
  // are inert and can be removed best-effort afterward.
  await snapshotStore.cleanup(snapshots);
  await snapshotStore.sync(snapshots);
  await rm(journalPath, { force: true });
  await syncPath(dirname(journalPath));
  await snapshotStore.remove(journalPath).catch(() => undefined);
};

const rollback = async (
  journal: RecoveryJournal,
  dependencies: UpdatePiDependencies,
  run: CommandRunner,
  journalPath: string,
  snapshotStore: UpdatePiSnapshotStore,
): Promise<UpdatePiResult> => {
  let rollbackEnvironment: NodeJS.ProcessEnv;
  let signature: RecordedSignature;
  try {
    const parsedSignature = parseRecordedSignature(journal.previousSignature);
    if (parsedSignature === undefined) {
      throw new Error("recorded Pi installation signature is invalid");
    }
    signature = parsedSignature;
    rollbackEnvironment = globalInstallEnvironment(
      signature,
      journal.rollbackArgv[0] ?? "",
    );
    const digestExecutable =
      dependencies.executableDigest ?? executableFileDigest;
    const actualDigest = await digestExecutable(journal.rollbackArgv[0] ?? "");
    if (actualDigest !== journal.rollbackExecutableDigest) {
      throw new Error("captured Bun executable digest changed");
    }
  } catch (error) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `automatic rollback refused an unverified captured Bun executable: ${String(error)}; manual recovery required—restore that Bun executable from a trusted source or use a trusted Bun to recover the recorded exact cohort; journal retained`,
    };
  }
  try {
    await snapshotStore.validate(journalPath, journal.snapshots);
  } catch (error) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `automatic rollback refused an unavailable or corrupt package snapshot before changing Pi: ${String(error)}; manual recovery required from a trusted backup; journal retained`,
    };
  }
  if (
    !(await snapshotStore.unrelatedStateMatches(journalPath, journal.snapshots))
  ) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message:
        "automatic rollback refused because unrelated Bun global metadata changed after preflight; journal retained for manual reconciliation",
    };
  }
  try {
    await snapshotStore.restoreMetadata(
      journalPath,
      journal.snapshots,
      signature,
    );
  } catch (error) {
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `automatic rollback could not restore preflight Bun metadata before reinstall: ${String(error)}; ${manualRecoveryFollowUp}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
  const result = await run(journal.rollbackArgv, {
    env: rollbackEnvironment,
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 512 * 1024,
  });
  let restorationFailure: unknown;
  try {
    const reinstalled = await dependencies.discover();
    if (installationSignature(reinstalled) !== journal.previousSignature) {
      throw new Error("reinstalled pi package cohort does not match preflight");
    }
    await snapshotStore.restore(journalPath, journal.snapshots, reinstalled);
  } catch (error) {
    restorationFailure = error;
  }
  try {
    if (!successful(result)) {
      throw new Error("rollback package install did not complete successfully");
    }
    if (restorationFailure !== undefined) {
      throw new Error("package-content restoration did not complete");
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
    if (!(await snapshotStore.matches(journal.snapshots))) {
      throw new Error("restored pi package contents do not match preflight");
    }
    await clearRecoveryState(journalPath, snapshotStore, journal.snapshots);
    return {
      ok: false,
      updated: false,
      rolledBack: true,
      previousVersion: journal.previousVersion,
      currentVersion: restored.installation.packageVersion,
      message: `candidate did not verify; restored exact pi ${journal.previousVersion} package contents`,
    };
  } catch (error) {
    const failures = [
      !successful(result)
        ? `package reinstall failed: ${result.stderr || result.stdout}`
        : undefined,
      restorationFailure === undefined
        ? undefined
        : `package-content restoration failed: ${String(restorationFailure)}`,
      `verification failed: ${String(error)}`,
    ].filter((item): item is string => item !== undefined);
    return {
      ok: false,
      updated: false,
      rolledBack: false,
      previousVersion: journal.previousVersion,
      message: `automatic rollback did not verify: ${failures.join("; ")}; ${manualRecoveryFollowUp}`,
      manualRecoveryArgv: journal.rollbackArgv,
    };
  }
};

export const updatePiSafely = async (
  dependencies: UpdatePiDependencies,
): Promise<UpdatePiResult> => {
  const run = dependencies.run ?? runCommand;
  const snapshotStore = dependencies.snapshotStore ?? fileSystemSnapshotStore;
  const digestExecutable =
    dependencies.executableDigest ?? executableFileDigest;
  const lockPath = dependencies.lockPath ?? defaultUpdateLockPath();
  const journalPath = dependencies.journalPath ?? defaultUpdateJournalPath();
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
            unfinished.previousSignature &&
          (await snapshotStore.matches(unfinished.snapshots))
        ) {
          await clearRecoveryState(
            journalPath,
            snapshotStore,
            unfinished.snapshots,
          );
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
      return rollback(
        unfinished,
        dependencies,
        run,
        journalPath,
        snapshotStore,
      );
    }

    // Establish a content-exact, known-good rollback target before mutation.
    const preflight = await dependencies.checkCompatibility();
    const previous = preflight.installation;
    const candidatePackages = candidatePackageSpecs(
      preflight,
      previous.packageName,
    );
    const updateEnvironment = globalInstallEnvironment(
      previous,
      previous.bunExecutable,
    );
    const rollbackPackages = rollbackPackageSpecs(previous);
    const rollbackArgv = [
      previous.bunExecutable,
      "install",
      "-g",
      "--ignore-scripts",
      "--force",
      ...rollbackPackages,
    ];
    const previousSignature = installationSignature(previous);
    const rollbackExecutableDigest = await digestExecutable(
      previous.bunExecutable,
    );
    if (!digestPattern.test(rollbackExecutableDigest)) {
      throw new Error("captured Bun executable digest is invalid");
    }
    const createdSnapshots = await snapshotStore.create(
      previous,
      journalPath,
      candidatePackages.map(packageNameFromSpec),
    );
    const recordedSignature = parseRecordedSignature(previousSignature);
    const packageSnapshots =
      recordedSignature === undefined
        ? undefined
        : parsePackageSnapshots(
            createdSnapshots.packages,
            recordedSignature,
            candidatePackages,
          );
    const metadataSnapshots =
      recordedSignature === undefined
        ? undefined
        : parseMetadataSnapshots(createdSnapshots.metadata, recordedSignature);
    const globalBinSnapshots =
      recordedSignature === undefined
        ? undefined
        : parseGlobalBinSnapshots(
            createdSnapshots.globalBins,
            recordedSignature,
          );
    const packageInventory =
      recordedSignature === undefined
        ? undefined
        : parsePackageInventory(
            createdSnapshots.packageInventory,
            recordedSignature,
          );
    if (
      packageSnapshots === undefined ||
      metadataSnapshots === undefined ||
      globalBinSnapshots === undefined ||
      packageInventory === undefined ||
      !transactionIdPattern.test(createdSnapshots.transactionId)
    ) {
      await snapshotStore.remove(journalPath).catch(() => undefined);
      throw new Error("recovery snapshot metadata does not match preflight");
    }
    const journal: RecoveryJournal = {
      schema: "pi-harness/update-recovery",
      version: 6,
      createdAt: new Date().toISOString(),
      packageName: previous.packageName,
      previousVersion: previous.packageVersion,
      previousSignature,
      candidatePackages,
      rollbackArgv,
      rollbackPackages,
      rollbackExecutableDigest,
      snapshots: {
        transactionId: createdSnapshots.transactionId,
        packages: packageSnapshots,
        metadata: metadataSnapshots,
        globalBins: globalBinSnapshots,
        packageInventory,
      },
    };
    try {
      await writeJournal(journalPath, journal);
    } catch (error) {
      const cleanupFailure = await clearRecoveryState(
        journalPath,
        snapshotStore,
        journal.snapshots,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [error, cleanupFailure],
          "failed to durably publish or clear Pi recovery state",
        );
      }
      throw error;
    }

    const updateResult = await run(
      [
        previous.bunExecutable,
        "install",
        "-g",
        "--ignore-scripts",
        "--force",
        ...candidatePackages,
      ],
      {
        env: updateEnvironment,
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
            installationSignature(previous) &&
          (await snapshotStore.matches(journal.snapshots))
        ) {
          await clearRecoveryState(
            journalPath,
            snapshotStore,
            journal.snapshots,
          );
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
      return rollback(journal, dependencies, run, journalPath, snapshotStore);
    }

    if (successful(updateResult)) {
      try {
        const candidate = await dependencies.checkCompatibility();
        if (
          !installationMatchesSpecs(candidate.installation, candidatePackages)
        ) {
          throw new Error("installed Pi cohort does not match local baseline");
        }
        await clearRecoveryState(journalPath, snapshotStore, journal.snapshots);
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

    return rollback(journal, dependencies, run, journalPath, snapshotStore);
  } finally {
    await lock.release();
  }
};
