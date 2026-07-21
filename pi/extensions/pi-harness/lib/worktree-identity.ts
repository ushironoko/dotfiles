import { isAbsolute } from "node:path";

export interface FileSystemIdentityV1 {
  readonly dev: string;
  readonly ino: string;
}

export interface WorktreeIdentityV1 {
  readonly version: 1;
  readonly path: string;
  readonly root: FileSystemIdentityV1;
  readonly dotGit: FileSystemIdentityV1;
  readonly gitDir: string;
}

export interface WorktreeIdentityDetailsV1 {
  readonly worktreeIdentity: WorktreeIdentityV1;
}

const DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const MAX_ID_DIGITS = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const safeAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= 16_384 &&
  isAbsolute(value) &&
  !value.includes("\0") &&
  !value.includes("\r") &&
  !value.includes("\n");

const parseFileIdentity = (
  value: unknown,
): FileSystemIdentityV1 | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ["dev", "ino"])) {
    return undefined;
  }
  const { dev, ino } = value;
  if (
    typeof dev !== "string" ||
    typeof ino !== "string" ||
    dev.length > MAX_ID_DIGITS ||
    ino.length > MAX_ID_DIGITS ||
    !DECIMAL_ID.test(dev) ||
    !DECIMAL_ID.test(ino)
  ) {
    return undefined;
  }
  return { dev, ino };
};

export const parseWorktreeIdentity = (
  value: unknown,
): WorktreeIdentityV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["dotGit", "gitDir", "path", "root", "version"]) ||
    value.version !== 1 ||
    !safeAbsolutePath(value.path) ||
    !safeAbsolutePath(value.gitDir)
  ) {
    return undefined;
  }
  const root = parseFileIdentity(value.root);
  const dotGit = parseFileIdentity(value.dotGit);
  if (root === undefined || dotGit === undefined) return undefined;
  return {
    version: 1,
    path: value.path,
    root,
    dotGit,
    gitDir: value.gitDir,
  };
};

export const worktreeIdentityDetails = (
  identity: WorktreeIdentityV1,
): WorktreeIdentityDetailsV1 => ({ worktreeIdentity: identity });

export const worktreeIdentityFromDetails = (
  details: unknown,
  expectedPath: string,
): WorktreeIdentityV1 | undefined => {
  if (!isRecord(details)) return undefined;
  const identity = parseWorktreeIdentity(details.worktreeIdentity);
  return identity?.path === expectedPath ? identity : undefined;
};

export const matchesFileIdentity = (
  stats: { readonly dev: bigint; readonly ino: bigint },
  identity: FileSystemIdentityV1,
): boolean =>
  stats.dev.toString(10) === identity.dev &&
  stats.ino.toString(10) === identity.ino;
