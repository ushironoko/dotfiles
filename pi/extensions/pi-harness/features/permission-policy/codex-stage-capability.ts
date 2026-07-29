import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CODEX_STAGE_MODES, type CodexStageMode } from "../../lib/agent-md";
import { isPathWithin } from "../../lib/trust";
import type { BashScratchBoundary } from "../bash-sandbox";
import type { PermissionProjectContext } from "./context";
import { scanCommand, type Segment } from "./scan";

export const CODEX_STAGE_CAPABILITY_ENV = "PI_HARNESS_CODEX_STAGE_CAPABILITY";

const CODEX_STAGE_WRAPPER = "~/.claude/hooks/lib/codex-stage.sh";
const PROMPT_PREFIX = "Read ";
const PROMPT_SUFFIX = " completely and follow it exactly.";
const EXPECTED_DIRECTORY_IDENTITY_FLAG = "--expected-dir-identity";
const EXPECTED_DIRECTORY_PATH_FLAG = "--expected-dir-path";
const SAFE_GIT_SELECTOR = /^[A-Za-z0-9._/@{}~^:+-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const SAFE_STAGED_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_WRAPPER_BYTES = 512 * 1024;
const MAX_STAGED_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_PRIVATE_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_PRIVATE_ARTIFACTS = 16;

export const consumeCodexStageCapability = (
  isChild: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<CodexStageMode> => {
  const raw = env[CODEX_STAGE_CAPABILITY_ENV];
  delete env[CODEX_STAGE_CAPABILITY_ENV];
  if (!isChild || raw === undefined || raw.length > 64) return new Set();

  const modes = raw.split(",");
  const knownModes = new Set<string>(CODEX_STAGE_MODES);
  if (
    modes.length === 0 ||
    modes.some((mode) => !knownModes.has(mode)) ||
    new Set(modes).size !== modes.length
  ) {
    return new Set();
  }
  return new Set(modes as CodexStageMode[]);
};

export interface CodexStageCapabilityRuntime {
  readonly executablePath: string;
  stageFile(
    sourcePath: string,
    scratchBoundary: BashScratchBoundary,
    fileName: "prompt.md" | "schema.json",
  ): Promise<string | undefined>;
  releaseFiles(paths: readonly string[]): void;
  dispose(): void;
}

interface CreateCodexStageCapabilityRuntimeOptions {
  readonly temporaryDirectory?: string;
}

interface PrivateArtifact {
  readonly directory: string;
  readonly bytes: number;
}

const removePrivateDirectory = (directory: string): void => {
  try {
    chmodSync(directory, 0o700);
  } catch {
    // A missing or already-cleaned directory needs no further preparation.
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Session cleanup is best-effort; capability files are non-writable and
    // live only in a private temporary directory.
  }
};

const hasExpectedOwner = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

const scratchIdentityMatches = async (
  boundary: BashScratchBoundary,
): Promise<boolean> => {
  if (!isAbsolute(boundary.path)) return false;
  try {
    const stat = await lstat(boundary.path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      `${stat.dev}:${stat.ino}` === boundary.identity
    );
  } catch {
    return false;
  }
};

const readBoundedFile = async (
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
): Promise<Buffer | undefined> => {
  const buffer = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === expectedBytes ? buffer.subarray(0, offset) : undefined;
};

const readTrustedExecutable = (source: string): Buffer => {
  const descriptor = openSync(
    source,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const initialStat = fstatSync(descriptor);
    if (
      !initialStat.isFile() ||
      initialStat.nlink !== 1 ||
      initialStat.size <= 0 ||
      initialStat.size > MAX_WRAPPER_BYTES ||
      !hasExpectedOwner(initialStat.uid)
    ) {
      throw new Error("trusted codex-stage wrapper is not a safe regular file");
    }
    const contents = Buffer.alloc(initialStat.size + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = readSync(
        descriptor,
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStat = fstatSync(descriptor);
    const currentStat = lstatSync(source);
    if (
      offset !== initialStat.size ||
      finalStat.dev !== initialStat.dev ||
      finalStat.ino !== initialStat.ino ||
      finalStat.size !== initialStat.size ||
      currentStat.isSymbolicLink() ||
      currentStat.dev !== initialStat.dev ||
      currentStat.ino !== initialStat.ino
    ) {
      throw new Error("trusted codex-stage wrapper changed while being pinned");
    }
    return contents.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
};

export const createCodexStageCapabilityRuntime = (
  sourceExecutable: string,
  options: CreateCodexStageCapabilityRuntimeOptions = {},
): CodexStageCapabilityRuntime => {
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const source = realpathSync(sourceExecutable);
  const executableContents = readTrustedExecutable(source);
  const executableDirectory = mkdtempSync(
    join(temporaryDirectory, "pi-codex-stage-bin-"),
  );
  const executablePath = join(executableDirectory, "codex-stage.sh");
  try {
    writeFileSync(executablePath, executableContents, {
      flag: "wx",
      mode: 0o500,
    });
    chmodSync(executableDirectory, 0o500);
  } catch (error) {
    removePrivateDirectory(executableDirectory);
    throw error;
  }

  const artifacts = new Map<string, PrivateArtifact>();
  let artifactBytes = 0;
  let inFlightArtifacts = 0;
  let inFlightBytes = 0;
  let disposed = false;
  const releaseFiles = (paths: readonly string[]): void => {
    for (const path of paths) {
      const artifact = artifacts.get(path);
      if (artifact === undefined) continue;
      artifacts.delete(path);
      artifactBytes -= artifact.bytes;
      removePrivateDirectory(artifact.directory);
    }
  };
  return {
    executablePath,
    async stageFile(sourcePath, scratchBoundary, fileName) {
      if (
        disposed ||
        !isAbsolute(sourcePath) ||
        dirname(sourcePath) !== scratchBoundary.path ||
        !SAFE_STAGED_FILE_NAME.test(basename(sourcePath)) ||
        !(await scratchIdentityMatches(scratchBoundary))
      ) {
        return undefined;
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let artifactDirectory: string | undefined;
      let reserved = false;
      let reservedBytes = 0;
      let registered = false;
      try {
        handle = await open(
          sourcePath,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        const openedStat = await handle.stat();
        if (
          disposed ||
          !openedStat.isFile() ||
          openedStat.nlink !== 1 ||
          openedStat.size > MAX_STAGED_ARTIFACT_BYTES ||
          !hasExpectedOwner(openedStat.uid) ||
          artifacts.size + inFlightArtifacts >= MAX_PRIVATE_ARTIFACTS ||
          artifactBytes + inFlightBytes + openedStat.size >
            MAX_PRIVATE_ARTIFACT_BYTES
        ) {
          return undefined;
        }
        inFlightArtifacts += 1;
        inFlightBytes += openedStat.size;
        reserved = true;
        reservedBytes = openedStat.size;

        const currentStat = await lstat(sourcePath);
        if (
          disposed ||
          currentStat.isSymbolicLink() ||
          !currentStat.isFile() ||
          currentStat.dev !== openedStat.dev ||
          currentStat.ino !== openedStat.ino
        ) {
          return undefined;
        }

        const contents = await readBoundedFile(handle, openedStat.size);
        if (disposed || contents === undefined) return undefined;
        const finalOpenedStat = await handle.stat();
        const finalCurrentStat = await lstat(sourcePath);
        if (
          disposed ||
          finalOpenedStat.dev !== openedStat.dev ||
          finalOpenedStat.ino !== openedStat.ino ||
          finalOpenedStat.size !== openedStat.size ||
          finalOpenedStat.nlink !== 1 ||
          !hasExpectedOwner(finalOpenedStat.uid) ||
          finalCurrentStat.isSymbolicLink() ||
          !finalCurrentStat.isFile() ||
          finalCurrentStat.dev !== openedStat.dev ||
          finalCurrentStat.ino !== openedStat.ino ||
          !(await scratchIdentityMatches(scratchBoundary))
        ) {
          return undefined;
        }
        artifactDirectory = await mkdtemp(
          join(temporaryDirectory, "pi-codex-stage-artifact-"),
        );
        if (disposed) return undefined;
        const artifactPath = join(artifactDirectory, fileName);
        await writeFile(artifactPath, contents, { flag: "wx", mode: 0o400 });
        if (disposed) return undefined;
        await chmod(artifactDirectory, 0o500);
        if (disposed) return undefined;
        artifacts.set(artifactPath, {
          directory: artifactDirectory,
          bytes: contents.byteLength,
        });
        artifactBytes += contents.byteLength;
        registered = true;
        return artifactPath;
      } catch {
        return undefined;
      } finally {
        if (reserved) {
          inFlightArtifacts -= 1;
          inFlightBytes -= reservedBytes;
        }
        await handle?.close().catch(() => {});
        if (artifactDirectory !== undefined && !registered) {
          removePrivateDirectory(artifactDirectory);
        }
      }
    },
    releaseFiles,
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseFiles([...artifacts.keys()]);
      removePrivateDirectory(executableDirectory);
    },
  };
};

const isLiteralSimpleSegment = (segment: Segment): boolean =>
  segment.topLevel &&
  segment.allowCandidate !== undefined &&
  !segment.hasAnsiC &&
  !segment.hasInputRedirection &&
  !segment.hasOutputRedirection &&
  segment.opaque.size === 0 &&
  segment.literalGlobs.size === 0;

interface CanonicalDirectory {
  readonly path: string;
  readonly identity: string;
}

const canonicalDirectory = async (
  path: string,
): Promise<CanonicalDirectory | undefined> => {
  if (!isAbsolute(path)) return undefined;
  try {
    const initialStat = await lstat(path);
    if (!initialStat.isDirectory() || initialStat.isSymbolicLink()) {
      return undefined;
    }
    const canonicalPath = await realpath(path);
    const canonicalStat = await lstat(canonicalPath);
    const finalStat = await lstat(path);
    if (
      !canonicalStat.isDirectory() ||
      canonicalStat.isSymbolicLink() ||
      !finalStat.isDirectory() ||
      finalStat.isSymbolicLink() ||
      initialStat.dev !== canonicalStat.dev ||
      initialStat.ino !== canonicalStat.ino ||
      finalStat.dev !== canonicalStat.dev ||
      finalStat.ino !== canonicalStat.ino
    ) {
      return undefined;
    }
    return {
      path: canonicalPath,
      identity: `${canonicalStat.dev}:${canonicalStat.ino}`,
    };
  } catch {
    return undefined;
  }
};

const stagedPromptSourcePath = (segment: Segment): string | undefined => {
  const [head, format, instruction] = segment.words;
  if (
    segment.words.length !== 3 ||
    head !== "printf" ||
    format !== "%s" ||
    instruction === undefined ||
    !instruction.startsWith(PROMPT_PREFIX) ||
    !instruction.endsWith(PROMPT_SUFFIX)
  ) {
    return undefined;
  }
  const path = instruction.slice(PROMPT_PREFIX.length, -PROMPT_SUFFIX.length);
  return path === "" || !isAbsolute(path) ? undefined : path;
};

interface ParsedWrapperCall {
  readonly mode: CodexStageMode;
  readonly args: readonly string[];
  readonly directory?: string;
  readonly directoryValueIndex?: number;
  readonly worktree?: string;
  readonly worktreeValueIndex?: number;
  readonly schema?: string;
  readonly schemaValueIndex?: number;
}

const consumeValue = (
  words: readonly string[],
  index: number,
): string | undefined => words[index + 1];

const parseWrapperCall = (segment: Segment): ParsedWrapperCall | undefined => {
  const [wrapper, rawMode, ...args] = segment.words;
  if (
    wrapper !== CODEX_STAGE_WRAPPER ||
    rawMode === undefined ||
    !CODEX_STAGE_MODES.includes(rawMode as CodexStageMode)
  ) {
    return undefined;
  }
  const mode = rawMode as CodexStageMode;
  let directory: string | undefined;
  let directoryValueIndex: number | undefined;
  let worktree: string | undefined;
  let worktreeValueIndex: number | undefined;
  let schema: string | undefined;
  let schemaValueIndex: number | undefined;
  let selectorCount = 0;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || seen.has(flag)) return undefined;
    seen.add(flag);
    switch (flag) {
      case "--timeout": {
        const value = consumeValue(args, index);
        if (
          value === undefined ||
          !POSITIVE_INTEGER.test(value) ||
          Number(value) > 3_600
        ) {
          return undefined;
        }
        index += 1;
        break;
      }
      case "--retry": {
        const value = consumeValue(args, index);
        if (
          value === undefined ||
          !NON_NEGATIVE_INTEGER.test(value) ||
          Number(value) > 10
        ) {
          return undefined;
        }
        index += 1;
        break;
      }
      case "--retry-wait": {
        const value = consumeValue(args, index);
        if (
          value === undefined ||
          !NON_NEGATIVE_INTEGER.test(value) ||
          Number(value) > 300
        ) {
          return undefined;
        }
        index += 1;
        break;
      }
      case "--dir": {
        if (mode !== "prompt" && mode !== "review" && mode !== "run") {
          return undefined;
        }
        directory = consumeValue(args, index);
        if (directory === undefined) return undefined;
        directoryValueIndex = index + 1;
        index += 1;
        break;
      }
      case "--worktree": {
        if (mode !== "poc") return undefined;
        worktree = consumeValue(args, index);
        if (worktree === undefined) return undefined;
        worktreeValueIndex = index + 1;
        index += 1;
        break;
      }
      case "--schema": {
        if (mode !== "prompt") return undefined;
        schema = consumeValue(args, index);
        if (schema === undefined) return undefined;
        schemaValueIndex = index + 1;
        index += 1;
        break;
      }
      case "--uncommitted": {
        if (mode !== "review") return undefined;
        selectorCount += 1;
        break;
      }
      case "--base":
      case "--commit": {
        if (mode !== "review") return undefined;
        const value = consumeValue(args, index);
        if (
          value === undefined ||
          value.startsWith("-") ||
          !SAFE_GIT_SELECTOR.test(value)
        ) {
          return undefined;
        }
        selectorCount += 1;
        index += 1;
        break;
      }
      case "--network": {
        if (mode !== "poc" && mode !== "run") return undefined;
        break;
      }
      default: {
        return undefined;
      }
    }
  }

  if (selectorCount > 1) return undefined;
  if (mode === "poc" && worktree === undefined) return undefined;
  if (mode === "run" && directory === undefined) return undefined;
  return {
    mode,
    args,
    ...(directory === undefined ? {} : { directory, directoryValueIndex }),
    ...(worktree === undefined ? {} : { worktree, worktreeValueIndex }),
    ...(schema === undefined ? {} : { schema, schemaValueIndex }),
  };
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export interface CodexStageCapabilityContext {
  readonly modes: ReadonlySet<CodexStageMode>;
  readonly cwd: string;
  readonly scratchBoundary?: BashScratchBoundary;
  readonly project: PermissionProjectContext;
  readonly runtime?: CodexStageCapabilityRuntime;
}

export interface AuthorizedCodexStageEscalation {
  readonly command: string;
  readonly artifacts: readonly string[];
}

export const authorizeCodexStageEscalation = async (
  command: string,
  context: CodexStageCapabilityContext,
): Promise<AuthorizedCodexStageEscalation | undefined> => {
  if (
    context.modes.size === 0 ||
    context.scratchBoundary === undefined ||
    context.project.kind !== "git" ||
    context.runtime === undefined
  ) {
    return undefined;
  }

  const { runtime, scratchBoundary } = context;
  const stagedArtifacts: string[] = [];
  const releaseStagedArtifacts = (): undefined => {
    runtime.releaseFiles(stagedArtifacts);
    return undefined;
  };
  const scan = scanCommand(command);
  if (
    !scan.ok ||
    scan.subs.length !== 0 ||
    scan.segments.length < 1 ||
    scan.segments.length > 2 ||
    scan.segments.some((segment) => !isLiteralSimpleSegment(segment))
  ) {
    return undefined;
  }

  const wrapperSegment = scan.segments.at(-1);
  if (wrapperSegment === undefined) return undefined;
  const parsed = parseWrapperCall(wrapperSegment);
  if (parsed === undefined || !context.modes.has(parsed.mode)) return undefined;

  const activeWorktree = await canonicalDirectory(
    context.project.activeWorktree,
  );
  if (activeWorktree === undefined) return undefined;

  let targetDirectory: CanonicalDirectory;
  let canonicalWorktree: CanonicalDirectory | undefined;
  if (parsed.mode === "poc") {
    canonicalWorktree =
      parsed.worktree === undefined
        ? undefined
        : await canonicalDirectory(parsed.worktree);
    if (
      canonicalWorktree === undefined ||
      canonicalWorktree.path !== activeWorktree.path
    ) {
      return undefined;
    }
    targetDirectory = canonicalWorktree;
  } else {
    const effectiveDirectory = parsed.directory ?? context.cwd;
    const canonicalTarget = await canonicalDirectory(effectiveDirectory);
    if (
      canonicalTarget === undefined ||
      !isPathWithin(canonicalTarget.path, activeWorktree.path)
    ) {
      return undefined;
    }
    targetDirectory = canonicalTarget;
  }

  if (parsed.mode === "review") {
    if (
      scan.segments.length !== 1 ||
      wrapperSegment.followedByAnd ||
      wrapperSegment.followedByPipe
    ) {
      return undefined;
    }
  } else {
    if (
      scan.segments.length !== 2 ||
      wrapperSegment.followedByAnd ||
      wrapperSegment.followedByPipe
    ) {
      return undefined;
    }
    const promptSegment = scan.segments[0] as Segment;
    if (!promptSegment.followedByPipe) return undefined;
  }

  const sanitizedArgs = [...parsed.args];
  if (parsed.directoryValueIndex !== undefined) {
    sanitizedArgs[parsed.directoryValueIndex] = targetDirectory.path;
  }
  if (
    parsed.worktreeValueIndex !== undefined &&
    canonicalWorktree !== undefined
  ) {
    sanitizedArgs[parsed.worktreeValueIndex] = canonicalWorktree.path;
  }
  if (parsed.schema !== undefined) {
    const privateSchema = await runtime.stageFile(
      parsed.schema,
      scratchBoundary,
      "schema.json",
    );
    if (privateSchema === undefined) return undefined;
    stagedArtifacts.push(privateSchema);
    if (parsed.schemaValueIndex === undefined) {
      return releaseStagedArtifacts();
    }
    sanitizedArgs[parsed.schemaValueIndex] = privateSchema;
  }
  sanitizedArgs.push(
    EXPECTED_DIRECTORY_IDENTITY_FLAG,
    targetDirectory.identity,
    EXPECTED_DIRECTORY_PATH_FLAG,
    targetDirectory.path,
  );
  const wrapperCommand = [
    context.runtime.executablePath,
    parsed.mode,
    ...sanitizedArgs,
  ]
    .map(shellQuote)
    .join(" ");

  if (parsed.mode === "review") {
    return { command: wrapperCommand, artifacts: stagedArtifacts };
  }
  const promptSegment = scan.segments[0] as Segment;
  const promptSource = stagedPromptSourcePath(promptSegment);
  if (promptSource === undefined) return releaseStagedArtifacts();
  const privatePrompt = await runtime.stageFile(
    promptSource,
    scratchBoundary,
    "prompt.md",
  );
  if (privatePrompt === undefined) return releaseStagedArtifacts();
  stagedArtifacts.push(privatePrompt);
  const instruction = `${PROMPT_PREFIX}${privatePrompt}${PROMPT_SUFFIX}`;
  return {
    command: `printf '%s' ${shellQuote(instruction)} | ${wrapperCommand}`,
    artifacts: stagedArtifacts,
  };
};
