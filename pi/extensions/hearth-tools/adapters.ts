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
  withFileMutationQueue,
  type BashOperations,
  type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import type {
  BashChunk,
  DiffHunk,
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
import type { PiToolSettings } from "./engine";

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
      return delegated.execute(id, params, signal, onUpdate, ctx);
    },
  };
  return definition;
};

export const createHearthReadTool = (
  cwd: string,
  engine: HearthEngine,
  settings: PiToolSettings,
) => {
  const base = createReadTool(cwd, {
    autoResizeImages: settings.imageAutoResize,
  });
  const tool: typeof base = {
    ...base,
    execute(id, params, signal, onUpdate) {
      return createReadTool(cwd, {
        autoResizeImages: settings.imageAutoResize,
        operations: hearthReadOperations(engine, signal),
      }).execute(id, params, signal, onUpdate);
    },
  };
  return tool;
};

export const createHearthWriteDefinition = (
  cwd: string,
  engine: HearthEngine,
) => {
  const base = createWriteToolDefinition(cwd);
  const definition: typeof base = {
    ...base,
    execute(id, params, signal, onUpdate, ctx) {
      const delegated = createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async () => {},
          writeFile: async (path, content) => {
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
          },
        },
      });
      return delegated.execute(id, params, signal, onUpdate, ctx);
    },
  };
  return definition;
};

const displayDiff = (
  hunks: DiffHunk[],
  oldLines: number,
  newLines: number,
): string => {
  const width = String(Math.max(oldLines, newLines)).length;
  const output: string[] = [];
  for (let index = 0; index < hunks.length; index += 1) {
    if (index > 0) output.push(` ${"".padStart(width)} ...`);
    for (const row of hunks[index]!.rows) {
      if (row.op === "insert") {
        output.push(`+${String(row.newLine).padStart(width)} ${row.text}`);
      } else if (row.op === "delete") {
        output.push(`-${String(row.oldLine).padStart(width)} ${row.text}`);
      } else {
        output.push(` ${String(row.oldLine).padStart(width)} ${row.text}`);
      }
    }
  }
  return output.join("\n");
};

const unifiedPatch = (path: string, hunks: DiffHunk[]): string => {
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const row of hunk.rows) {
      const prefix =
        row.op === "insert" ? "+" : row.op === "delete" ? "-" : " ";
      lines.push(`${prefix}${row.text}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

export const createHearthEditDefinition = (
  cwd: string,
  engine: HearthEngine,
) => {
  const base = createEditToolDefinition(cwd);
  const definition: typeof base = {
    ...base,
    async execute(_id, input, signal) {
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error(
          "Edit tool input is invalid. edits must contain at least one replacement.",
        );
      }
      const path = absolutePath(cwd, input.path);
      return withFileMutationQueue(path, async () => {
        const result = await engine.editBatchAsync(
          {
            path,
            edits: input.edits,
            diffContext: 4,
            mode: "inPlace" as WriteMode,
            followSymlinks: true,
          },
          signal,
        );
        const details: EditToolDetails = {
          diff: displayDiff(
            result.hunks,
            result.oldLineCount,
            result.newLineCount,
          ),
          patch: unifiedPatch(input.path, result.hunks),
          ...(result.firstChangedLine === undefined
            ? {}
            : { firstChangedLine: result.firstChangedLine }),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.`,
            },
          ],
          details,
        };
      });
    },
  };
  return definition;
};

export const createHearthGrepDefinition = (
  cwd: string,
  engine: HearthEngine,
) => {
  const base = createGrepToolDefinition(cwd);
  const definition: typeof base = {
    ...base,
    async execute(_id, input, signal) {
      const searchPath = absolutePath(cwd, input.path || ".");
      const limit = Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT);
      const context = input.context && input.context > 0 ? input.context : 0;
      const result = await engine.grepAsync(
        {
          pattern: input.pattern,
          path: searchPath,
          mode: "content" as GrepMode,
          globs: input.glob ? [input.glob] : [],
          caseInsensitive: input.ignoreCase ?? false,
          fixedStrings: input.literal ?? false,
          beforeContext: context,
          afterContext: context,
          maxTotalCount: limit,
          hidden: true,
          respectGitignore: true,
        },
        signal,
      );
      if (result.totalMatches === 0) {
        return {
          content: [{ type: "text" as const, text: "No matches found" }],
          details: undefined,
        };
      }

      let linesTruncated = false;
      const lines: string[] = [];
      for (const file of result.files) {
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
      const matchLimitReached = result.limitReached ? limit : undefined;
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

export const createHearthBashOperations = (
  engine: HearthEngine,
  shell: ShellSpec,
): BashOperations => ({
  async exec(command, cwd, options) {
    try {
      const result = await engine.bashStream(
        {
          command,
          cwd,
          timeoutMs: timeoutMs(options.timeout),
          env: environment(options.env),
          shell,
          collectOutput: false,
        },
        (chunk: BashChunk) => options.onData(Buffer.from(chunk.text, "utf8")),
        options.signal,
      );
      if (result.aborted) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: result.exitCode };
    } catch (error) {
      if (errorMessage(error).startsWith("indeterminate:")) {
        throw new Error(
          "Hearth reported an indeterminate command outcome; inspect state before retrying",
        );
      }
      throw error;
    } finally {
      engine.clearCaches();
    }
  },
});

export const createHearthBashDefinition = (
  cwd: string,
  engine: HearthEngine,
  settings: PiToolSettings,
) =>
  createBashToolDefinition(cwd, {
    commandPrefix: settings.shellCommandPrefix,
    shellPath: settings.shellPath,
    operations: createHearthBashOperations(engine, settings.shell),
  });
