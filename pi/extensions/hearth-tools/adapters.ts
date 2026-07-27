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
import {
  IMMEDIATE_HEARTH_ACCESS_GATE,
  type HearthAccessGate,
  type PiToolSettings,
} from "./engine";

const DEFAULT_GREP_LIMIT = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;

const absolutePath = (cwd: string, input: string): string => {
  let normalized = input.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/"))
    normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
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

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const asciiAt = (buffer: Buffer, offset: number, text: string): boolean =>
  buffer.length >= offset + text.length &&
  [...text].every(
    (character, index) => buffer[offset + index] === character.charCodeAt(0),
  );

const validBmp = (buffer: Buffer): boolean => {
  if (buffer.length < 26) return false;
  const size = buffer.readUInt32LE(2);
  const pixels = buffer.readUInt32LE(10);
  const dib = buffer.readUInt32LE(14);
  if (
    (size !== 0 && size < 26) ||
    pixels < 14 + dib ||
    (size !== 0 && pixels >= size)
  ) {
    return false;
  }
  if (dib !== 12 && buffer.length < 30) return false;
  const planes = buffer.readUInt16LE(dib === 12 ? 22 : 26);
  const bits = buffer.readUInt16LE(dib === 12 ? 24 : 28);
  return (
    (dib === 12 || (dib >= 40 && dib <= 124)) &&
    planes === 1 &&
    [1, 4, 8, 16, 24, 32].includes(bits)
  );
};

const animatedPng = (buffer: Buffer): boolean => {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (asciiAt(buffer, offset + 4, "acTL")) return true;
    if (asciiAt(buffer, offset + 4, "IDAT")) return false;
    const next = offset + 12 + length;
    if (next <= offset || next > buffer.length) return false;
    offset = next;
  }
  return false;
};

const imageMime = async (path: string): Promise<string | null> => {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4_100);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const data = bytes.subarray(0, bytesRead);
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return data[3] === 0xf7 ? null : "image/jpeg";
    }
    if (
      data.subarray(0, 8).equals(PNG_SIGNATURE) &&
      data.length >= 16 &&
      data.readUInt32BE(8) === 13 &&
      asciiAt(data, 12, "IHDR")
    ) {
      return animatedPng(data) ? null : "image/png";
    }
    if (asciiAt(data, 0, "GIF")) return "image/gif";
    if (asciiAt(data, 0, "RIFF") && asciiAt(data, 8, "WEBP"))
      return "image/webp";
    if (asciiAt(data, 0, "BM") && validBmp(data)) return "image/bmp";
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
  const base = createReadToolDefinition(cwd, {
    autoResizeImages: settings.imageAutoResize,
  });
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
  const base = createWriteToolDefinition(cwd);
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
  const base = createEditToolDefinition(cwd);
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

const hearthGlobs = (
  searchPath: string,
  glob: string | undefined,
): string[] => {
  if (glob === undefined || glob.startsWith("!")) return [];
  const normalized = normalizedGlobPath(glob);
  if (!normalized.includes("/")) return [normalized];
  return [
    normalizedGlobPath(resolve(searchPath, normalized.replace(/^\/+/, ""))),
  ];
};

const excludeNegativeGlob = (
  files: FileMatches[],
  root: string,
  glob: string | undefined,
): FileMatches[] => {
  if (glob === undefined || !glob.startsWith("!")) return files;
  const matcher = new Bun.Glob(glob.slice(1));
  return files.filter((file) => {
    const relativePath = normalizedGlobPath(relative(root, file.path));
    return !(
      matcher.match(relativePath) ||
      matcher.match(normalizedGlobPath(basename(file.path)))
    );
  });
};

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
  const base = createGrepToolDefinition(cwd);
  const definition: typeof base = {
    ...base,
    execute(_id, input, signal) {
      return gate.shared(async () => {
        const searchPath = absolutePath(cwd, input.path || ".");
        const limit = Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT);
        const context = input.context && input.context > 0 ? input.context : 0;
        const negativeGlob = input.glob?.startsWith("!") === true;
        const result = await engine
          .grepAsync(
            {
              pattern: input.pattern,
              path: searchPath,
              mode: "content" as GrepMode,
              globs: hearthGlobs(searchPath, input.glob),
              caseInsensitive: input.ignoreCase ?? false,
              fixedStrings: input.literal ?? false,
              beforeContext: context,
              afterContext: context,
              ...(negativeGlob ? {} : { maxTotalCount: limit }),
              hidden: true,
              respectGitignore: true,
            },
            signal,
          )
          .catch((error) => mapCancelled(error, "Operation aborted"));

        const filtered = excludeNegativeGlob(
          result.files,
          result.root,
          input.glob,
        );
        const totalMatches = filtered.reduce(
          (total, file) => total + file.matchCount,
          0,
        );
        if (totalMatches === 0) {
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: undefined,
          };
        }

        const files = negativeGlob
          ? limitFileMatches(filtered, limit, context)
          : filtered;
        let linesTruncated = false;
        const lines: string[] = [];
        for (const file of files) {
          const shownPath = result.rootIsDir
            ? relative(result.root, file.path).replaceAll("\\", "/")
            : basename(file.path);
          for (const line of file.lines) {
            const truncated = truncateLine(line.text.replaceAll("\r", ""));
            linesTruncated ||= truncated.wasTruncated;
            lines.push(
              line.isMatch
                ? `${shownPath}:${line.lineNumber}: ${truncated.text}`
                : `${shownPath}-${line.lineNumber}- ${truncated.text}`,
            );
          }
        }
        const truncation = truncateHead(lines.join("\n"), {
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        const limitReached = negativeGlob
          ? totalMatches >= limit
          : result.limitReached;
        const matchLimitReached = limitReached ? limit : undefined;
        const notices: string[] = [];
        if (matchLimitReached !== undefined) {
          notices.push(
            `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
          );
        }
        if (truncation.truncated)
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        if (linesTruncated)
          notices.push(
            "Some lines truncated to 500 chars. Use read tool to see full lines",
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
  const milliseconds = seconds * 1000;
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`,
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
          throw new Error(`timeout:${effectiveTimeoutMs / 1000}`);
        return {
          exitCode:
            result.signal !== undefined && result.exitCode === -1
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
  createBashToolDefinition(cwd, {
    commandPrefix: settings.shellCommandPrefix,
    shellPath: settings.shellPath,
    operations: createHearthBashOperations(
      engine,
      settings.shell,
      adapterOptions,
    ),
  });
