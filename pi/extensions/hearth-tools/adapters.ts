import {
  createBashToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  BashChunk,
  FileMatches,
  GrepMode,
  HearthEngine,
  ShellSpec,
  WriteMode,
} from "@hearthdev/napi";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TIMEOUT_MS } from "./constants";
import {
  IMMEDIATE_HEARTH_ACCESS_GATE,
  type HearthAccessGate,
  type PiToolSettings,
} from "./engine";
import { withStatusTitle } from "./status-title";

const FILE_REFERENCE_PREFIX = "@";
const HOME_DIRECTORY_TOKEN = "~";
const HOME_DIRECTORY_PREFIX = "~/";
const FILE_URL_PREFIX = "file://";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const FILE_START_OFFSET = 0;

const DEFAULT_GREP_LIMIT = 100;
const MIN_GREP_LIMIT = 1;
const FIRST_LINE_NUMBER = 1;
const NO_CONTEXT_LINES = 0;
const GREP_LIMIT_REFINEMENT_MULTIPLIER = 2;
const GREP_MAX_LINE_LENGTH = 500;
const GLOB_SCAN_MIN = 1_000;
const GLOB_SCAN_MAX = 100_000;
const GLOB_SCAN_MULTIPLIER = 100;
const MILLISECONDS_PER_SECOND = 1_000;
const HEARTH_SIGNAL_EXIT_CODE = -1;

// Mirrors pi 0.80.7's bounded image sniffer and supported MIME contract.
const IMAGE_TYPE_SNIFF_BYTES = 4_100;
const ASCII_ENCODING = "ascii";
const IMAGE_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
} as const;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_MARKER_OFFSET = JPEG_SIGNATURE.length;
const JPEG_LS_MARKER = 0xf7;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_CHUNK_LENGTH_BYTES = 4;
const PNG_CHUNK_TYPE_BYTES = 4;
const PNG_CHUNK_CRC_BYTES = 4;
const PNG_CHUNK_HEADER_BYTES = PNG_CHUNK_LENGTH_BYTES + PNG_CHUNK_TYPE_BYTES;
const PNG_CHUNK_OVERHEAD_BYTES = PNG_CHUNK_HEADER_BYTES + PNG_CHUNK_CRC_BYTES;
const PNG_CHUNK_TYPE_OFFSET = PNG_CHUNK_LENGTH_BYTES;
const PNG_IHDR_DATA_LENGTH = 13;
const PNG_IHDR_DATA_LENGTH_OFFSET = PNG_SIGNATURE.length;
const PNG_IHDR_TYPE_OFFSET =
  PNG_IHDR_DATA_LENGTH_OFFSET + PNG_CHUNK_LENGTH_BYTES;
const PNG_MIN_HEADER_BYTES = PNG_IHDR_TYPE_OFFSET + PNG_CHUNK_TYPE_BYTES;
const PNG_ANIMATION_CONTROL_CHUNK = Buffer.from("acTL", ASCII_ENCODING);
const PNG_IMAGE_DATA_CHUNK = Buffer.from("IDAT", ASCII_ENCODING);
const PNG_HEADER_CHUNK = Buffer.from("IHDR", ASCII_ENCODING);

const GIF_SIGNATURE = Buffer.from("GIF", ASCII_ENCODING);
const RIFF_SIGNATURE = Buffer.from("RIFF", ASCII_ENCODING);
const RIFF_SIZE_FIELD_BYTES = 4;
const WEBP_SIGNATURE = Buffer.from("WEBP", ASCII_ENCODING);
const WEBP_FORMAT_OFFSET = RIFF_SIGNATURE.length + RIFF_SIZE_FIELD_BYTES;

const BMP_SIGNATURE = Buffer.from("BM", ASCII_ENCODING);
const BMP_FILE_HEADER_BYTES = 14;
const BMP_CORE_DIB_HEADER_BYTES = 12;
const BMP_INFO_DIB_HEADER_MIN_BYTES = 40;
const BMP_INFO_DIB_HEADER_MAX_BYTES = 124;
const BMP_MIN_HEADER_BYTES = BMP_FILE_HEADER_BYTES + BMP_CORE_DIB_HEADER_BYTES;
const BMP_FILE_SIZE_OFFSET = 2;
const BMP_PIXEL_DATA_OFFSET = 10;
const BMP_DIB_HEADER_SIZE_OFFSET = 14;
const BMP_CORE_PLANES_OFFSET = 22;
const BMP_CORE_BITS_PER_PIXEL_OFFSET = 24;
const BMP_INFO_PLANES_OFFSET = 26;
const BMP_INFO_BITS_PER_PIXEL_OFFSET = 28;
const BMP_FIELD_BYTES = 2;
const BMP_INFO_MIN_FILE_BYTES =
  BMP_INFO_BITS_PER_PIXEL_OFFSET + BMP_FIELD_BYTES;
const BMP_UNKNOWN_FILE_SIZE = 0;
const BMP_REQUIRED_COLOR_PLANES = 1;
const BMP_SUPPORTED_BITS_PER_PIXEL: ReadonlySet<number> = new Set([
  1, 4, 8, 16, 24, 32,
]);

const absolutePath = (cwd: string, input: string): string => {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith(FILE_REFERENCE_PREFIX)) {
    normalized = normalized.slice(FILE_REFERENCE_PREFIX.length);
  }
  if (normalized === HOME_DIRECTORY_TOKEN) normalized = homedir();
  else if (normalized.startsWith(HOME_DIRECTORY_PREFIX)) {
    normalized = join(
      homedir(),
      normalized.slice(HOME_DIRECTORY_PREFIX.length),
    );
  }
  if (normalized.startsWith(FILE_URL_PREFIX)) {
    normalized = fileURLToPath(normalized);
  }
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const mapCancelled = (error: unknown, message: string): never => {
  if (errorMessage(error).startsWith("cancelled:")) throw new Error(message);
  throw error;
};

const signatureAt = (
  buffer: Buffer,
  offset: number,
  signature: Buffer,
): boolean =>
  buffer.length >= offset + signature.length &&
  buffer.subarray(offset, offset + signature.length).equals(signature);

const validBmp = (buffer: Buffer): boolean => {
  if (buffer.length < BMP_MIN_HEADER_BYTES) return false;
  const size = buffer.readUInt32LE(BMP_FILE_SIZE_OFFSET);
  const pixels = buffer.readUInt32LE(BMP_PIXEL_DATA_OFFSET);
  const dib = buffer.readUInt32LE(BMP_DIB_HEADER_SIZE_OFFSET);
  if (
    (size !== BMP_UNKNOWN_FILE_SIZE && size < BMP_MIN_HEADER_BYTES) ||
    pixels < BMP_FILE_HEADER_BYTES + dib ||
    (size !== BMP_UNKNOWN_FILE_SIZE && pixels >= size)
  ) {
    return false;
  }
  if (
    dib !== BMP_CORE_DIB_HEADER_BYTES &&
    buffer.length < BMP_INFO_MIN_FILE_BYTES
  ) {
    return false;
  }
  const coreHeader = dib === BMP_CORE_DIB_HEADER_BYTES;
  const planes = buffer.readUInt16LE(
    coreHeader ? BMP_CORE_PLANES_OFFSET : BMP_INFO_PLANES_OFFSET,
  );
  const bits = buffer.readUInt16LE(
    coreHeader
      ? BMP_CORE_BITS_PER_PIXEL_OFFSET
      : BMP_INFO_BITS_PER_PIXEL_OFFSET,
  );
  const supportedHeader =
    coreHeader ||
    (dib >= BMP_INFO_DIB_HEADER_MIN_BYTES &&
      dib <= BMP_INFO_DIB_HEADER_MAX_BYTES);
  return (
    supportedHeader &&
    planes === BMP_REQUIRED_COLOR_PLANES &&
    BMP_SUPPORTED_BITS_PER_PIXEL.has(bits)
  );
};

const animatedPng = (buffer: Buffer): boolean => {
  let offset = PNG_SIGNATURE.length;
  while (offset + PNG_CHUNK_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeOffset = offset + PNG_CHUNK_TYPE_OFFSET;
    if (signatureAt(buffer, typeOffset, PNG_ANIMATION_CONTROL_CHUNK))
      return true;
    if (signatureAt(buffer, typeOffset, PNG_IMAGE_DATA_CHUNK)) return false;
    const next = offset + PNG_CHUNK_OVERHEAD_BYTES + length;
    if (next <= offset || next > buffer.length) return false;
    offset = next;
  }
  return false;
};

const imageMime = async (path: string): Promise<string | null> => {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(
      bytes,
      FILE_START_OFFSET,
      bytes.length,
      FILE_START_OFFSET,
    );
    const data = bytes.subarray(FILE_START_OFFSET, bytesRead);
    if (signatureAt(data, FILE_START_OFFSET, JPEG_SIGNATURE)) {
      return data[JPEG_MARKER_OFFSET] === JPEG_LS_MARKER
        ? null
        : IMAGE_MIME.jpeg;
    }
    if (
      signatureAt(data, FILE_START_OFFSET, PNG_SIGNATURE) &&
      data.length >= PNG_MIN_HEADER_BYTES &&
      data.readUInt32BE(PNG_IHDR_DATA_LENGTH_OFFSET) === PNG_IHDR_DATA_LENGTH &&
      signatureAt(data, PNG_IHDR_TYPE_OFFSET, PNG_HEADER_CHUNK)
    ) {
      return animatedPng(data) ? null : IMAGE_MIME.png;
    }
    if (signatureAt(data, FILE_START_OFFSET, GIF_SIGNATURE)) {
      return IMAGE_MIME.gif;
    }
    if (
      signatureAt(data, FILE_START_OFFSET, RIFF_SIGNATURE) &&
      signatureAt(data, WEBP_FORMAT_OFFSET, WEBP_SIGNATURE)
    ) {
      return IMAGE_MIME.webp;
    }
    if (signatureAt(data, FILE_START_OFFSET, BMP_SIGNATURE) && validBmp(data)) {
      return IMAGE_MIME.bmp;
    }
    return null;
  } finally {
    await handle.close();
  }
};

const hearthReadOperations = (
  engine: HearthEngine,
  signal: AbortSignal | undefined,
) => ({
  access: (path: string) => access(path, constants.R_OK),
  detectImageMimeType: imageMime,
  readFile: (path: string) => engine.readBytesAsync({ path }, signal),
});

export const createHearthReadDefinition = (
  cwd: string,
  engine: HearthEngine,
  settings: PiToolSettings,
  gate: HearthAccessGate = IMMEDIATE_HEARTH_ACCESS_GATE,
) => {
  const base = withStatusTitle(
    createReadToolDefinition(cwd, {
      autoResizeImages: settings.imageAutoResize,
    }),
    "all-content",
  );
  const definition: typeof base = {
    ...base,
    execute(id, params, signal, onUpdate, ctx) {
      const delegated = createReadToolDefinition(cwd, {
        autoResizeImages: settings.imageAutoResize,
        operations: hearthReadOperations(engine, signal),
      });
      return gate.shared(() =>
        delegated.execute(id, params, signal, onUpdate, ctx),
      );
    },
  };
  return definition;
};

export const createHearthReadTool = (
  cwd: string,
  engine: HearthEngine,
  settings: PiToolSettings,
  gate: HearthAccessGate = IMMEDIATE_HEARTH_ACCESS_GATE,
) => {
  const base = createReadTool(cwd, {
    autoResizeImages: settings.imageAutoResize,
  });
  const tool: typeof base = {
    ...base,
    execute(id, params, signal, onUpdate) {
      return gate.shared(() =>
        createReadTool(cwd, {
          autoResizeImages: settings.imageAutoResize,
          operations: hearthReadOperations(engine, signal),
        }).execute(id, params, signal, onUpdate),
      );
    },
  };
  return tool;
};

export const createHearthWriteDefinition = (
  cwd: string,
  engine: HearthEngine,
  gate: HearthAccessGate = IMMEDIATE_HEARTH_ACCESS_GATE,
) => {
  const base = withStatusTitle(createWriteToolDefinition(cwd));
  const definition: typeof base = {
    ...base,
    execute(id, params, signal, onUpdate, ctx) {
      const delegated = createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async () => {},
          writeFile: async (path, content) => {
            try {
              await engine.writeAsync(
                {
                  path,
                  content,
                  createDirs: true,
                  mode: "inPlace" as WriteMode,
                  followSymlinks: true,
                },
                signal,
              );
            } catch (error) {
              mapCancelled(error, "Operation aborted");
            }
          },
        },
      });
      return gate.shared(() =>
        delegated.execute(id, params, signal, onUpdate, ctx),
      );
    },
  };
  return definition;
};

export const createHearthEditDefinition = (
  cwd: string,
  engine: HearthEngine,
  gate: HearthAccessGate = IMMEDIATE_HEARTH_ACCESS_GATE,
) => {
  const base = withStatusTitle(createEditToolDefinition(cwd));
  const definition: typeof base = {
    ...base,
    execute(id, input, signal, onUpdate, ctx) {
      const delegated = createEditToolDefinition(cwd, {
        operations: {
          access: (path) =>
            access(path, constants.R_OK | constants.W_OK).catch((error) =>
              mapCancelled(error, "Operation aborted"),
            ),
          readFile: (path) =>
            engine
              .readBytesAsync({ path }, signal)
              .catch((error) => mapCancelled(error, "Operation aborted")),
          writeFile: async (path, content) => {
            try {
              await engine.writeAsync(
                {
                  path,
                  content,
                  createDirs: false,
                  mode: "inPlace" as WriteMode,
                  followSymlinks: true,
                },
                signal,
              );
            } catch (error) {
              mapCancelled(error, "Operation aborted");
            }
          },
        },
      });
      return gate.shared(() =>
        delegated.execute(id, input, signal, onUpdate, ctx),
      );
    },
  };
  return definition;
};

const normalizedGlobPath = (value: string): string =>
  value.replaceAll("\\", "/");

interface GrepGlob {
  original: string;
  negative: boolean;
  rooted: boolean;
  directoryOnly: boolean;
  pattern: string;
  hasSlash: boolean;
  matcher: Bun.Glob;
}

const parseGrepGlob = (glob: string | undefined): GrepGlob | undefined => {
  if (glob === undefined) return undefined;
  const negative = glob.startsWith("!");
  const rawPattern = negative ? glob.slice(1) : glob;
  const rooted = rawPattern.startsWith("/");
  const directoryOnly = rawPattern.endsWith("/");
  const withoutRoot = rawPattern.replace(/^\/+/, "");
  const pattern = directoryOnly ? withoutRoot.slice(0, -1) : withoutRoot;
  return {
    original: glob,
    negative,
    rooted,
    directoryOnly,
    pattern,
    hasSlash: pattern.includes("/"),
    matcher: new Bun.Glob(pattern),
  };
};

const hearthGlobs = (glob: GrepGlob | undefined): string[] => {
  if (glob === undefined) return [];
  if (glob.negative || glob.rooted || glob.directoryOnly || glob.hasSlash) {
    // Hearth's native globset is the same strict parser family as ripgrep.
    // `**` keeps the candidate walk unfiltered while the second entry validates
    // malformed classes, ranges, alternates, and escapes before JS post-filtering.
    return ["**", glob.original];
  }
  return [glob.original];
};

const ancestorPaths = (path: string): string[] => {
  const segments = path.split("/");
  return segments
    .slice(0, -1)
    .map((_segment, index) => segments.slice(0, index + 1).join("/"));
};

const matchesNegativeGlob = (path: string, glob: GrepGlob): boolean => {
  const ancestors = ancestorPaths(path);
  if (!glob.rooted && !glob.hasSlash) {
    const segments = path.split("/");
    const candidates = glob.directoryOnly ? segments.slice(0, -1) : segments;
    return candidates.some((segment) => glob.matcher.match(segment));
  }
  const candidates = glob.directoryOnly ? ancestors : [...ancestors, path];
  return candidates.some((candidate) => glob.matcher.match(candidate));
};

const filterPostProcessedGlob = (
  files: FileMatches[],
  cwd: string,
  glob: GrepGlob | undefined,
  rootIsDirectory: boolean,
): FileMatches[] => {
  if (
    glob === undefined ||
    !rootIsDirectory ||
    (!glob.negative && !glob.rooted && !glob.directoryOnly && !glob.hasSlash)
  ) {
    return files;
  }
  return files.filter((file) => {
    const relativePath = normalizedGlobPath(relative(cwd, file.path));
    if (glob.negative) return !matchesNegativeGlob(relativePath, glob);
    if (glob.directoryOnly) return false;
    return glob.matcher.match(relativePath);
  });
};

const postFilterGlobScanLimit = (limit: number): number =>
  Math.min(
    GLOB_SCAN_MAX,
    Math.max(GLOB_SCAN_MIN, limit * GLOB_SCAN_MULTIPLIER),
  );

const limitFileMatches = (
  files: FileMatches[],
  limit: number,
  context: number,
): FileMatches[] => {
  let remaining = limit;
  const limited: FileMatches[] = [];
  for (const file of files) {
    if (remaining === 0) break;
    const matchLines = file.lines
      .filter((line) => line.isMatch)
      .slice(0, remaining)
      .map((line) => line.lineNumber);
    if (matchLines.length === 0) continue;
    const kept = new Set(matchLines);
    limited.push({
      ...file,
      matchCount: matchLines.length,
      lines: file.lines.filter((line) =>
        line.isMatch
          ? kept.has(line.lineNumber)
          : matchLines.some(
              (matchLine) => Math.abs(matchLine - line.lineNumber) <= context,
            ),
      ),
    });
    remaining -= matchLines.length;
  }
  return limited;
};

export const createHearthGrepDefinition = (
  cwd: string,
  engine: HearthEngine,
  gate: HearthAccessGate = IMMEDIATE_HEARTH_ACCESS_GATE,
) => {
  const base = withStatusTitle(createGrepToolDefinition(cwd), "all-content");
  const definition: typeof base = {
    ...base,
    execute(_id, input, signal) {
      return gate.shared(async () => {
        const searchPath = absolutePath(cwd, input.path || ".");
        const limit = Math.max(
          MIN_GREP_LIMIT,
          input.limit ?? DEFAULT_GREP_LIMIT,
        );
        const context =
          input.context && input.context > NO_CONTEXT_LINES
            ? input.context
            : NO_CONTEXT_LINES;
        const glob = parseGrepGlob(input.glob);
        const postFilterGlob =
          glob !== undefined &&
          (glob.negative || glob.rooted || glob.directoryOnly || glob.hasSlash);
        const result = await engine
          .grepAsync(
            {
              pattern: input.pattern,
              path: searchPath,
              mode: "content" as GrepMode,
              globs: hearthGlobs(glob),
              caseInsensitive: input.ignoreCase ?? false,
              fixedStrings: input.literal ?? false,
              beforeContext: context,
              afterContext: context,
              maxTotalCount: postFilterGlob
                ? postFilterGlobScanLimit(limit)
                : limit,
              hidden: true,
              respectGitignore: true,
            },
            signal,
          )
          .catch((error) => mapCancelled(error, "Operation aborted"));

        const filtered = filterPostProcessedGlob(
          result.files,
          cwd,
          glob,
          result.rootIsDir,
        );
        const totalMatches = filtered.reduce(
          (total, file) => total + file.matchCount,
          0,
        );
        if (postFilterGlob && result.limitReached && totalMatches < limit) {
          const kind = glob?.negative ? "Negative" : "Positive";
          throw new Error(
            `${kind} glob candidate scan limit reached before enough included matches; refine pattern or path`,
          );
        }
        if (totalMatches === 0) {
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: undefined,
          };
        }

        const files = postFilterGlob
          ? limitFileMatches(filtered, limit, context)
          : filtered;
        let linesTruncated = false;
        const lines: string[] = [];
        for (const file of files) {
          const shownPath = result.rootIsDir
            ? relative(result.root, file.path).replaceAll("\\", "/")
            : basename(file.path);
          const matches = file.lines.filter((line) => line.isMatch);
          let fullLines: string[] | undefined;
          if (context > NO_CONTEXT_LINES) {
            try {
              const content = await engine.readBytesAsync(
                { path: file.path },
                signal,
              );
              fullLines = content
                .toString("utf8")
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n")
                .split("\n");
            } catch (error) {
              mapCancelled(error, "Operation aborted");
            }
          }
          for (const match of matches) {
            const firstLine = Math.max(
              FIRST_LINE_NUMBER,
              match.lineNumber - context,
            );
            const block =
              context === NO_CONTEXT_LINES || fullLines === undefined
                ? [match]
                : fullLines
                    .slice(
                      firstLine - 1,
                      Math.min(fullLines.length, match.lineNumber + context),
                    )
                    .map((text, index) => ({
                      lineNumber: firstLine + index,
                      text,
                    }));
            for (const line of block) {
              const truncated = truncateLine(line.text.replaceAll("\r", ""));
              linesTruncated ||= truncated.wasTruncated;
              lines.push(
                line.lineNumber === match.lineNumber
                  ? `${shownPath}:${line.lineNumber}: ${truncated.text}`
                  : `${shownPath}-${line.lineNumber}- ${truncated.text}`,
              );
            }
          }
        }
        const truncation = truncateHead(lines.join("\n"), {
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        const limitReached = postFilterGlob
          ? totalMatches >= limit
          : result.limitReached;
        const matchLimitReached = limitReached ? limit : undefined;
        const notices: string[] = [];
        if (matchLimitReached !== undefined) {
          notices.push(
            `${limit} matches limit reached. Use limit=${limit * GREP_LIMIT_REFINEMENT_MULTIPLIER} for more, or refine pattern`,
          );
        }
        if (truncation.truncated)
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        if (linesTruncated)
          notices.push(
            `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
          );
        const output = `${truncation.content}${
          notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`
        }`;
        return {
          content: [{ type: "text" as const, text: output }],
          details:
            matchLimitReached === undefined &&
            !truncation.truncated &&
            !linesTruncated
              ? undefined
              : {
                  ...(matchLimitReached === undefined
                    ? {}
                    : { matchLimitReached }),
                  ...(truncation.truncated ? { truncation } : {}),
                  ...(linesTruncated ? { linesTruncated: true } : {}),
                },
        };
      });
    },
  };
  return definition;
};

const timeoutMs = (seconds: number | undefined): number | undefined => {
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const milliseconds = seconds * MILLISECONDS_PER_SECOND;
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / MILLISECONDS_PER_SECOND} seconds`,
    );
  }
  return milliseconds;
};

const environment = (
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export interface HearthBashAdapterOptions {
  defaultTimeoutMs?: number;
  gate?: HearthAccessGate;
  operations?: BashOperations;
}

export const createHearthBashOperations = (
  engine: HearthEngine,
  shell: ShellSpec,
  adapterOptions: HearthBashAdapterOptions = {},
): BashOperations => ({
  exec(command, cwd, options) {
    const gate = adapterOptions.gate ?? IMMEDIATE_HEARTH_ACCESS_GATE;
    return gate.exclusive(async () => {
      const effectiveTimeoutMs =
        timeoutMs(options.timeout) ??
        adapterOptions.defaultTimeoutMs ??
        MAX_TIMEOUT_MS;
      try {
        const result = await engine.bashStream(
          {
            command,
            cwd,
            timeoutMs: effectiveTimeoutMs,
            env: environment(options.env),
            shell,
            collectOutput: false,
          },
          (chunk: BashChunk) => options.onData(Buffer.from(chunk.text, "utf8")),
          options.signal,
        );
        if (result.aborted) throw new Error("aborted");
        if (result.timedOut)
          throw new Error(
            `timeout:${effectiveTimeoutMs / MILLISECONDS_PER_SECOND}`,
          );
        return {
          exitCode:
            result.signal !== undefined &&
            result.exitCode === HEARTH_SIGNAL_EXIT_CODE
              ? null
              : result.exitCode,
        };
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith("cancelled:")) throw new Error("aborted");
        if (message.startsWith("indeterminate:")) {
          throw new Error(
            "Hearth reported an indeterminate command outcome; inspect state before retrying",
          );
        }
        throw error;
      } finally {
        engine.clearCaches();
      }
    });
  },
});

export const createHearthBashDefinition = (
  cwd: string,
  engine: HearthEngine,
  settings: PiToolSettings,
  adapterOptions: HearthBashAdapterOptions = {},
) =>
  withStatusTitle(
    createBashToolDefinition(cwd, {
      commandPrefix: settings.shellCommandPrefix,
      shellPath: settings.shellPath,
      operations:
        adapterOptions.operations ??
        createHearthBashOperations(engine, settings.shell, adapterOptions),
    }),
    "all-content",
  );
