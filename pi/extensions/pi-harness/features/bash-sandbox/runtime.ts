import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sanitizeChildEnv } from "../../lib/child-env";

export const CONTROLLED_BASH_PATH = "/bin/bash";

const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TZ",
  "USER",
]);

export const buildControlledBashEnv = (
  source: NodeJS.ProcessEnv,
  cwd: string,
  scratchDirectory: string,
): Record<string, string> => {
  const sanitized = sanitizeChildEnv(source, {}, { cwd });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_KEYS.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.HOME = sanitized.HOME ?? homedir();
  env.PATH = sanitized.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  env.SHELL = CONTROLLED_BASH_PATH;
  env.TMPDIR = scratchDirectory;
  env.TMP = scratchDirectory;
  env.TEMP = scratchDirectory;
  env.XDG_CACHE_HOME = join(scratchDirectory, "cache");
  return env;
};

interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

interface SpawnOptions {
  cwd: string;
  detached: true;
  env: Record<string, string>;
  stdio: ["ignore", "pipe", "pipe"];
}

type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedProcess;

interface ActiveAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

const activeAbortSignal = (value: unknown): ActiveAbortSignal | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("aborted" in value) ||
    typeof value.aborted !== "boolean" ||
    !("addEventListener" in value) ||
    typeof value.addEventListener !== "function" ||
    !("removeEventListener" in value) ||
    typeof value.removeEventListener !== "function"
  ) {
    return undefined;
  }
  return value as ActiveAbortSignal;
};

interface ControlledBashOptions {
  readonly getScratchDirectory: () => string | undefined;
  readonly wrapCommand?: (
    command: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly spawnFn?: SpawnFunction;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

const killProcessGroup = (
  child: SpawnedProcess,
  signal: NodeJS.Signals,
): void => {
  if (typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
};

export const createControlledBashOperations = (
  options: ControlledBashOptions,
): BashOperations => ({
  async exec(command, cwd, execution) {
    const scratchDirectory = options.getScratchDirectory();
    if (scratchDirectory === undefined) {
      throw new Error("bash sandbox is not ready");
    }
    const signal = activeAbortSignal(execution.signal);
    const isAborted = (): boolean => signal?.aborted === true;
    if (isAborted()) throw new Error("aborted");
    const effectiveCommand =
      options.wrapCommand === undefined
        ? command
        : await options.wrapCommand(
            command,
            signal as unknown as AbortSignal | undefined,
          );
    if (isAborted()) throw new Error("aborted");
    const spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFunction);
    const env = buildControlledBashEnv(
      execution.env ?? options.baseEnv ?? process.env,
      cwd,
      scratchDirectory,
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const child = spawnFn(
        CONTROLLED_BASH_PATH,
        ["--noprofile", "--norc", "-c", effectiveCommand],
        {
          cwd,
          detached: true,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const cleanup = (): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        killProcessGroup(child, "SIGKILL");
      };

      child.stdout?.on("data", execution.onData);
      child.stderr?.on("data", execution.onData);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (execution.timeout !== undefined && execution.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child, "SIGKILL");
        }, execution.timeout * 1_000);
      }
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (isAborted()) {
          reject(new Error("aborted"));
        } else if (timedOut) {
          reject(new Error(`timeout:${execution.timeout}`));
        } else {
          resolve({ exitCode: code });
        }
      });
      if (isAborted()) onAbort();
    });
  },
});

export type { ControlledBashOptions, SpawnFunction, SpawnedProcess };
