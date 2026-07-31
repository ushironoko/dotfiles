import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isPathWithin, type TrustConfig } from "../../lib/trust";

export type GitObjectFormat = "sha1" | "sha256";

export interface MemoryRepository {
  readonly cwd: string;
  readonly topLevel: string;
  readonly commonDir: string;
  readonly objectFormat: GitObjectFormat;
  readonly trustSource: "direct" | "linked-worktree";
}

export interface RepositoryCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type RunRepositoryGit = (
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<RepositoryCommandResult>;

export type RepositoryFailureKind =
  | "invalid-data"
  | "non-git"
  | "unsupported"
  | "untrusted";

export class MemoryRepositoryError extends Error {
  constructor(
    readonly kind: RepositoryFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "MemoryRepositoryError";
  }
}

interface ResolveRepositoryOptions {
  readonly runGit: RunRepositoryGit;
  readonly realpath?: (path: string) => Promise<string>;
}

const fatalDecoder = new TextDecoder(undefined, { fatal: true });
const MAX_TRUSTED_ROOTS = 64;

const decodeLines = (bytes: Uint8Array, label: string): string[] => {
  let output: string;
  try {
    output = fatalDecoder.decode(bytes);
  } catch {
    throw new MemoryRepositoryError(
      "invalid-data",
      `${label} is not valid UTF-8`,
    );
  }
  return output.trimEnd().split(/\r?\n/);
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const validAbsolutePath = (value: string): boolean =>
  value !== "" && isAbsolute(value) && !hasControlCharacter(value);

const canonicalPath = async (
  value: string,
  resolveRealpath: (path: string) => Promise<string>,
  label: string,
): Promise<string> => {
  if (!validAbsolutePath(value)) {
    throw new MemoryRepositoryError("invalid-data", `${label} is invalid`);
  }
  try {
    const canonical = await resolveRealpath(value);
    if (!validAbsolutePath(canonical)) throw new Error("invalid path");
    return canonical;
  } catch {
    throw new MemoryRepositoryError(
      "invalid-data",
      `${label} does not resolve`,
    );
  }
};

const parseRepositoryIdentity = async (
  cwd: string,
  runGit: RunRepositoryGit,
  resolveRealpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<{
  topLevel: string;
  commonDir: string;
  objectFormat: GitObjectFormat;
}> => {
  const result = await runGit(
    cwd,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--show-object-format",
    ],
    signal,
  );
  if (result.exitCode !== 0) {
    throw new MemoryRepositoryError("non-git", "Git repository unavailable");
  }
  const lines = decodeLines(result.stdout, "Git repository identity");
  if (lines.length !== 3) {
    throw new MemoryRepositoryError(
      "unsupported",
      "Git did not return top-level, common-dir, and object format",
    );
  }
  const [rawTopLevel, rawCommonDir, rawObjectFormat] = lines;
  if (
    rawTopLevel === undefined ||
    rawCommonDir === undefined ||
    (rawObjectFormat !== "sha1" && rawObjectFormat !== "sha256")
  ) {
    throw new MemoryRepositoryError(
      "unsupported",
      "Git object format is unsupported",
    );
  }
  const [topLevel, commonDir] = await Promise.all([
    canonicalPath(rawTopLevel, resolveRealpath, "Git top-level"),
    canonicalPath(rawCommonDir, resolveRealpath, "Git common-dir"),
  ]);
  return { topLevel, commonDir, objectFormat: rawObjectFormat };
};

const rootRepositoryCommonDir = async (
  root: string,
  runGit: RunRepositoryGit,
  resolveRealpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const result = await runGit(
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  if (result.exitCode !== 0) return undefined;
  const lines = decodeLines(result.stdout, "trusted-root Git identity");
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new MemoryRepositoryError(
      "invalid-data",
      "trusted-root Git common-dir is invalid",
    );
  }
  return canonicalPath(
    lines[0],
    resolveRealpath,
    "trusted-root Git common-dir",
  );
};

const pathTrustedForRepository = async (
  candidateTopLevel: string,
  commonDir: string,
  trust: TrustConfig,
  runGit: RunRepositoryGit,
  resolveRealpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<boolean> => {
  for (const configuredRoot of trust.trustedRoots.slice(0, MAX_TRUSTED_ROOTS)) {
    let root: string;
    try {
      root = await resolveRealpath(configuredRoot);
    } catch {
      continue;
    }
    if (!isPathWithin(candidateTopLevel, root)) continue;

    // A configured root that is itself inside a Git repository grants trust
    // only to that same common-dir. This prevents a nested repository from
    // inheriting trust merely because its path is below a trusted checkout.
    const rootCommonDir = await rootRepositoryCommonDir(
      root,
      runGit,
      resolveRealpath,
      signal,
    );
    if (rootCommonDir === undefined || rootCommonDir === commonDir) return true;
  }
  return false;
};

const worktreePaths = (bytes: Uint8Array): string[] => {
  const lines = decodeLines(bytes, "Git worktree list");
  return lines
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
};

export const resolveMemoryRepository = async (
  cwd: string,
  trust: TrustConfig,
  options: ResolveRepositoryOptions,
  signal?: AbortSignal,
): Promise<MemoryRepository> => {
  const resolveRealpath = options.realpath ?? realpath;
  let canonicalCwd: string;
  try {
    canonicalCwd = await resolveRealpath(cwd);
  } catch {
    throw new MemoryRepositoryError("non-git", "Working directory unavailable");
  }

  const identity = await parseRepositoryIdentity(
    canonicalCwd,
    options.runGit,
    resolveRealpath,
    signal,
  );
  if (
    await pathTrustedForRepository(
      identity.topLevel,
      identity.commonDir,
      trust,
      options.runGit,
      resolveRealpath,
      signal,
    )
  ) {
    return { cwd: canonicalCwd, ...identity, trustSource: "direct" };
  }

  const listed = await options.runGit(
    canonicalCwd,
    ["worktree", "list", "--porcelain"],
    signal,
  );
  if (listed.exitCode !== 0) {
    throw new MemoryRepositoryError("untrusted", "Repository is not trusted");
  }
  for (const rawPath of worktreePaths(listed.stdout)) {
    let candidate: string;
    try {
      candidate = await resolveRealpath(rawPath);
    } catch {
      continue;
    }
    if (candidate === identity.topLevel) continue;
    if (
      !(await pathTrustedForRepository(
        candidate,
        identity.commonDir,
        trust,
        options.runGit,
        resolveRealpath,
        signal,
      ))
    ) {
      continue;
    }
    const candidateIdentity = await parseRepositoryIdentity(
      candidate,
      options.runGit,
      resolveRealpath,
      signal,
    );
    if (candidateIdentity.commonDir === identity.commonDir) {
      return {
        cwd: canonicalCwd,
        ...identity,
        trustSource: "linked-worktree",
      };
    }
  }

  throw new MemoryRepositoryError("untrusted", "Repository is not trusted");
};
