import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionJudgeConfig } from "../../config";

const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_AUTH_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DENIED_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const AUTH_ROOT_KEYS = new Set([
  "OPENAI_API_KEY",
  "auth_mode",
  "last_refresh",
  "tokens",
]);
const AUTH_TOKEN_KEYS = new Set([
  "access_token",
  "account_id",
  "id_token",
  "refresh_token",
]);

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
}

export interface PermissionJudgeRuntimeIdentity extends FileIdentity {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly ancestorFingerprint: string;
  readonly fingerprint: string;
}

export interface PermissionJudgeWorkspace {
  readonly cwd: string;
  readonly home: string;
  readonly codexHome: string;
  readonly instructionsFile: string;
  readonly schemaFile: string;
  readonly modelCatalogFile: string;
  readonly deniedImageFile: string;
  readonly environment: Record<string, string>;
  cleanup(): void;
}

export interface PermissionJudgeRuntime {
  readonly identity: PermissionJudgeRuntimeIdentity;
  readonly runtimeRoot: string;
  readonly codexVersion?: string;
  readonly isolationVerified?: boolean;
  verify(): PermissionJudgeRuntimeIdentity;
  assertOutsideWorktrees(worktrees: readonly string[]): void;
  createWorkspace(
    instructions: string,
    schema: string,
    modelCatalog: string,
    instructionSentinel?: string,
  ): PermissionJudgeWorkspace;
}

export interface PermissionJudgeRuntimeOptions {
  readonly runtimeRoot: string;
  readonly authFile?: string;
}

export const permissionJudgeRuntimeOptions = (
  home: string,
): PermissionJudgeRuntimeOptions => ({
  runtimeRoot: join(home, ".pi", "agent", "pi-harness", "permission-judge"),
  authFile: join(home, ".codex", "auth.json"),
});

const hasExpectedOwner = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.mode === right.mode &&
  left.size === right.size;

const fileIdentity = (stat: ReturnType<typeof fstatSync>): FileIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  uid: Number(stat.uid),
  mode: Number(stat.mode),
  size: Number(stat.size),
});

const readFileSnapshot = (
  path: string,
  maximumBytes: number,
  requireExecutable: boolean,
): { readonly bytes: Buffer; readonly identity: FileIdentity } => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const initialStat = fstatSync(descriptor);
    const initialIdentity = fileIdentity(initialStat);
    if (
      !initialStat.isFile() ||
      initialStat.nlink !== 1 ||
      initialStat.size <= 0 ||
      initialStat.size > maximumBytes ||
      !hasExpectedOwner(initialStat.uid) ||
      (initialStat.mode & 0o022) !== 0 ||
      (requireExecutable && (initialStat.mode & 0o111) === 0)
    ) {
      throw new Error("permission judge file identity is not trusted");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < initialStat.size) {
      const chunk = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, initialStat.size - total),
      );
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const finalStat = fstatSync(descriptor);
    const currentStat = lstatSync(path);
    const finalIdentity = fileIdentity(finalStat);
    const currentIdentity = fileIdentity(currentStat);
    if (
      total !== initialStat.size ||
      currentStat.isSymbolicLink() ||
      !sameFileIdentity(initialIdentity, finalIdentity) ||
      !sameFileIdentity(initialIdentity, currentIdentity)
    ) {
      throw new Error("permission judge file changed while being read");
    }
    return {
      bytes: Buffer.concat(chunks, total),
      identity: initialIdentity,
    };
  } finally {
    closeSync(descriptor);
  }
};

const directoryIdentity = (path: string): string => {
  const stat = lstatSync(path);
  const sharedStickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.uid !== 0 && !hasExpectedOwner(stat.uid)) ||
    ((stat.mode & 0o022) !== 0 && !sharedStickyRoot)
  ) {
    throw new Error("permission judge executable ancestor is not trusted");
  }
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
};

const trustedAncestors = (path: string): string => {
  const identities: string[] = [];
  let cursor = dirname(path);
  while (true) {
    identities.push(`${cursor}:${directoryIdentity(cursor)}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return createHash("sha256").update(identities.join("\0")).digest("hex");
};

export const inspectPermissionJudgeExecutable = (
  config: PermissionJudgeConfig,
): PermissionJudgeRuntimeIdentity => {
  if (
    !config.enabled ||
    config.configurationError !== undefined ||
    !isAbsolute(config.executablePath) ||
    !/^[0-9a-f]{64}$/.test(config.expectedExecutableSha256)
  ) {
    throw new Error("permission judge executable configuration is invalid");
  }
  const executablePath = resolve(config.executablePath);
  if (realpathSync(executablePath) !== executablePath) {
    throw new Error("permission judge executable path is not canonical");
  }
  const snapshot = readFileSnapshot(executablePath, MAX_EXECUTABLE_BYTES, true);
  const executableSha256 = createHash("sha256")
    .update(snapshot.bytes)
    .digest("hex");
  if (executableSha256 !== config.expectedExecutableSha256) {
    throw new Error("permission judge executable digest did not match");
  }
  const ancestorFingerprint = trustedAncestors(executablePath);
  const identity = {
    ...snapshot.identity,
    executablePath,
    executableSha256,
    ancestorFingerprint,
  };
  return {
    ...identity,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex"),
  };
};

const ensurePrivateDirectory = (path: string): string => {
  if (!isAbsolute(path)) {
    throw new Error("permission judge runtime root must be absolute");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(path);
  const stat = lstatSync(path);
  if (
    canonical !== resolve(path) ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !hasExpectedOwner(stat.uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("permission judge runtime root is not private");
  }
  return canonical;
};

const pathWithin = (candidate: string, root: string): boolean => {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  );
};

const validateAuthentication = (bytes: Buffer): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("permission judge authentication file is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("permission judge authentication file is invalid");
  }
  const auth = parsed as Record<string, unknown>;
  if (Object.keys(auth).some((key) => !AUTH_ROOT_KEYS.has(key))) {
    throw new Error("permission judge authentication file is invalid");
  }
  if (
    (auth.OPENAI_API_KEY !== undefined &&
      auth.OPENAI_API_KEY !== null &&
      typeof auth.OPENAI_API_KEY !== "string") ||
    (auth.auth_mode !== undefined && typeof auth.auth_mode !== "string") ||
    (auth.last_refresh !== undefined &&
      typeof auth.last_refresh !== "string") ||
    (auth.tokens !== undefined &&
      (auth.tokens === null ||
        typeof auth.tokens !== "object" ||
        Array.isArray(auth.tokens)))
  ) {
    throw new Error("permission judge authentication file is invalid");
  }
  if (auth.tokens !== undefined) {
    const tokens = auth.tokens as Record<string, unknown>;
    if (
      Object.keys(tokens).some((key) => !AUTH_TOKEN_KEYS.has(key)) ||
      Object.values(tokens).some((value) => typeof value !== "string")
    ) {
      throw new Error("permission judge authentication file is invalid");
    }
  }
};

const copyAuthentication = (
  source: string | undefined,
  destination: string,
): void => {
  if (source === undefined || !existsSync(source)) return;
  const canonical = resolve(source);
  if (realpathSync(canonical) !== canonical) {
    throw new Error("permission judge authentication path is not canonical");
  }
  trustedAncestors(canonical);
  const snapshot = readFileSnapshot(canonical, MAX_AUTH_BYTES, false);
  if ((snapshot.identity.mode & 0o077) !== 0) {
    throw new Error("permission judge authentication file is not private");
  }
  validateAuthentication(snapshot.bytes);
  writeFileSync(destination, snapshot.bytes, { flag: "wx", mode: 0o600 });
};

const removeWorkspace = (directory: string): void => {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory)) {
    throw new Error("permission judge workspace cleanup failed");
  }
};

export const createPermissionJudgeRuntime = (
  config: PermissionJudgeConfig,
  options: PermissionJudgeRuntimeOptions,
): PermissionJudgeRuntime => {
  const identity = inspectPermissionJudgeExecutable(config);
  const runtimeRoot = ensurePrivateDirectory(options.runtimeRoot);
  const verify = (): PermissionJudgeRuntimeIdentity => {
    const current = inspectPermissionJudgeExecutable(config);
    if (current.fingerprint !== identity.fingerprint) {
      throw new Error("permission judge executable identity changed");
    }
    if (ensurePrivateDirectory(runtimeRoot) !== runtimeRoot) {
      throw new Error("permission judge runtime root changed");
    }
    return current;
  };
  return {
    identity,
    runtimeRoot,
    verify,
    assertOutsideWorktrees(worktrees) {
      if (worktrees.some((worktree) => pathWithin(runtimeRoot, worktree))) {
        throw new Error("permission judge runtime root is inside a worktree");
      }
    },
    createWorkspace(instructions, schema, modelCatalog, instructionSentinel) {
      verify();
      const directory = mkdtempSync(join(runtimeRoot, "run-"));
      const cwd = join(directory, "workspace");
      const home = join(directory, "home");
      const codexHome = join(directory, "codex-home");
      const temporaryDirectory = join(directory, "tmp");
      const instructionsFile = join(cwd, "instructions.md");
      const schemaFile = join(cwd, "output-schema.json");
      const modelCatalogFile = join(cwd, "model-catalog.json");
      const deniedImageFile = join(directory, "denied-image.png");
      try {
        chmodSync(directory, 0o700);
        mkdirSync(cwd, { mode: 0o700 });
        mkdirSync(home, { mode: 0o700 });
        mkdirSync(codexHome, { mode: 0o700 });
        mkdirSync(temporaryDirectory, { mode: 0o700 });
        copyAuthentication(options.authFile, join(codexHome, "auth.json"));
        writeFileSync(instructionsFile, instructions, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(schemaFile, schema, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(modelCatalogFile, modelCatalog, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(deniedImageFile, DENIED_IMAGE_BYTES, {
          flag: "wx",
          mode: 0o600,
        });
        if (instructionSentinel !== undefined) {
          writeFileSync(join(cwd, "AGENTS.md"), instructionSentinel, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        }
      } catch (error) {
        removeWorkspace(directory);
        throw error;
      }
      let cleaned = false;
      return {
        cwd,
        home,
        codexHome,
        instructionsFile,
        schemaFile,
        modelCatalogFile,
        deniedImageFile,
        environment: {
          HOME: home,
          CODEX_HOME: codexHome,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          NO_COLOR: "1",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          PWD: cwd,
          TERM: "dumb",
          TMPDIR: temporaryDirectory,
        },
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          removeWorkspace(directory);
        },
      };
    },
  };
};
