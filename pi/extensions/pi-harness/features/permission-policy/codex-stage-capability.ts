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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_STAGE_MODES, type CodexStageMode } from "../../lib/agent-md";
import { scanCommand, type Segment } from "./scan";

export const CODEX_STAGE_CAPABILITY_ENV = "PI_HARNESS_CODEX_STAGE_CAPABILITY";

const CODEX_STAGE_WRAPPER = "~/.claude/hooks/lib/codex-stage.sh";
const PROMPT_PREFIX = "Read ";
const PROMPT_SUFFIX = " completely and follow it exactly.";
const MAX_WRAPPER_BYTES = 512 * 1024;

export interface CodexStageExecutablePin {
  readonly executablePath: string;
  dispose(): void;
}

const removePrivateDirectory = (directory: string): void => {
  try {
    chmodSync(directory, 0o700);
  } catch {
    // A missing or already-cleaned directory needs no preparation.
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Session cleanup is best-effort; the pinned file is non-writable and
    // contains only the versioned wrapper, not prompts or model output.
  }
};

const hasExpectedOwner = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

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

/**
 * Snapshot only the trusted launcher into a private, read-only executable.
 *
 * This is not an execution sandbox and does not inspect or alter Codex
 * arguments, cwd, worktree, prompts, or output. It closes the launcher TOCTOU
 * between child startup and the child's one authorized escalated call.
 */
export const createCodexStageExecutablePin = (
  sourceExecutable: string,
  temporaryDirectory: string = tmpdir(),
): CodexStageExecutablePin => {
  const source = realpathSync(sourceExecutable);
  const contents = readTrustedExecutable(source);
  const directory = mkdtempSync(
    join(temporaryDirectory, "pi-codex-stage-bin-"),
  );
  const executablePath = join(directory, "codex-stage.sh");
  try {
    writeFileSync(executablePath, contents, { flag: "wx", mode: 0o500 });
    chmodSync(directory, 0o500);
  } catch (error) {
    removePrivateDirectory(directory);
    throw error;
  }
  let disposed = false;
  return {
    executablePath,
    dispose() {
      if (disposed) return;
      disposed = true;
      removePrivateDirectory(directory);
    },
  };
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const pinCodexStageCommand = (
  command: string,
  executablePath: string,
  wrapperIndex: number,
): string | undefined => {
  if (
    wrapperIndex < 0 ||
    command.slice(wrapperIndex, wrapperIndex + CODEX_STAGE_WRAPPER.length) !==
      CODEX_STAGE_WRAPPER
  ) {
    return undefined;
  }
  return `${command.slice(0, wrapperIndex)}${shellQuote(executablePath)}${command.slice(wrapperIndex + CODEX_STAGE_WRAPPER.length)}`;
};

/**
 * Consume the managed-child capability once at extension startup.
 *
 * The parent derives this value from trusted agent frontmatter. Repository task
 * text and shell commands cannot add modes, and a parent process never accepts
 * the environment value as a capability for itself.
 */
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

const isLiteralSimpleSegment = (segment: Segment): boolean =>
  segment.topLevel &&
  segment.allowCandidate !== undefined &&
  !segment.hasAnsiC &&
  !segment.hasInputRedirection &&
  !segment.hasOutputRedirection &&
  segment.opaque.size === 0 &&
  segment.literalGlobs.size === 0;

const wrapperMode = (segment: Segment): CodexStageMode | undefined => {
  const [wrapper, rawMode] = segment.words;
  if (
    wrapper !== CODEX_STAGE_WRAPPER ||
    rawMode === undefined ||
    !CODEX_STAGE_MODES.includes(rawMode as CodexStageMode)
  ) {
    return undefined;
  }
  return rawMode as CodexStageMode;
};

const isStagedPromptProducer = (segment: Segment): boolean => {
  const [head, format, instruction] = segment.words;
  return (
    segment.words.length === 3 &&
    head === "printf" &&
    format === "%s" &&
    instruction !== undefined &&
    instruction.startsWith(PROMPT_PREFIX) &&
    instruction.endsWith(PROMPT_SUFFIX) &&
    instruction.length > PROMPT_PREFIX.length + PROMPT_SUFFIX.length
  );
};

const isShellWhitespace = (value: string | undefined): boolean =>
  value !== undefined && /\s/u.test(value);

const wrapperTokenAt = (command: string, index: number): boolean =>
  command.startsWith(CODEX_STAGE_WRAPPER, index) &&
  (index + CODEX_STAGE_WRAPPER.length === command.length ||
    isShellWhitespace(command[index + CODEX_STAGE_WRAPPER.length]));

const firstCommandTokenIndex = (command: string): number => {
  let index = 0;
  while (isShellWhitespace(command[index])) index += 1;
  return index;
};

const startsShellComment = (command: string, index: number): boolean => {
  if (command[index] !== "#") return false;
  const previous = command[index - 1];
  return (
    previous === undefined ||
    isShellWhitespace(previous) ||
    previous === ";" ||
    previous === "|" ||
    previous === "&" ||
    previous === "(" ||
    previous === ")"
  );
};

const topLevelPipeIndex = (command: string): number | undefined => {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== "single" && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (startsShellComment(command, index)) {
      const newline = command.indexOf("\n", index + 1);
      if (newline === -1) return undefined;
      index = newline;
      continue;
    }
    if (
      character === "|" &&
      command[index - 1] !== "|" &&
      command[index + 1] !== "|"
    ) {
      return index;
    }
  }
  return undefined;
};

const literalWrapperIndex = (
  command: string,
  mode: CodexStageMode,
): number | undefined => {
  if (mode === "review") {
    const index = firstCommandTokenIndex(command);
    return wrapperTokenAt(command, index) ? index : undefined;
  }
  const pipe = topLevelPipeIndex(command);
  if (pipe === undefined) return undefined;
  let index = pipe + 1;
  while (isShellWhitespace(command[index])) index += 1;
  return wrapperTokenAt(command, index) ? index : undefined;
};

export interface CodexStageAuthorization {
  readonly mode: CodexStageMode;
  readonly wrapperIndex: number;
}

export const authorizeCodexStageEscalation = (
  command: string,
  modes: ReadonlySet<CodexStageMode>,
): CodexStageAuthorization | undefined => {
  if (modes.size === 0) return undefined;

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

  const wrapper = scan.segments.at(-1);
  if (wrapper === undefined) return undefined;
  const mode = wrapperMode(wrapper);
  if (
    mode === undefined ||
    !modes.has(mode) ||
    wrapper.followedByAnd ||
    wrapper.followedByPipe
  ) {
    return undefined;
  }

  const wrapperIndex = literalWrapperIndex(command, mode);
  if (wrapperIndex === undefined) return undefined;
  if (mode === "review") {
    return scan.segments.length === 1 ? { mode, wrapperIndex } : undefined;
  }
  if (scan.segments.length !== 2) return undefined;

  const [producer] = scan.segments;
  return producer !== undefined &&
    producer.followedByPipe &&
    isStagedPromptProducer(producer)
    ? { mode, wrapperIndex }
    : undefined;
};
