import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentDefinition } from "../../lib/agent-md";
import { sanitizeChildEnv } from "../../lib/child-env";
import type { ChildObservation } from "../child-runs/model";
import { createChildProtocolParser } from "../child-runs/protocol";
import {
  CHILD_PERMISSION_SIGNAL_ENV,
  formatChildPermissionSignal,
} from "../permission-policy/block";

const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Parser-protection ceiling: lines beyond this are dropped unparsed. Kept
// above PER_TASK_OUTPUT_CAP so oversized-but-parseable payloads still get
// capped text with the truncation marker instead of disappearing.
const LINE_DROP_CAP = PER_TASK_OUTPUT_CAP * 4;
const SIGTERM_GRACE_MS = 2000;
const TRUNCATION_MARKER = "\n\n[Output truncated.]";
// A child that stopped for one of these reasons did NOT finish its task, even
// when it exits 0. "length" (token/output limit) truncates the response
// mid-flight, so treating it as success would silently count a partial result
// (review finding).
const FAILED_STOP_REASONS: ReadonlySet<string> = new Set([
  "error",
  "aborted",
  "length",
]);

interface ReadableLike {
  on(
    event: "data",
    listener: (chunk: string | Uint8Array) => void,
  ): ReadableLike;
}

interface SpawnedProcess {
  stdout: ReadableLike;
  stderr: ReadableLike;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): SpawnedProcess;
  on(event: "error", listener: (error: Error) => void): SpawnedProcess;
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed: boolean;
  readonly pid?: number;
}

interface SpawnLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  // Own process group so aborting can SIGKILL the whole tree (a pi child may
  // spawn grandchildren that ignore SIGTERM); kill(-pid) reaps them.
  detached: true;
}

// Signal the child's whole process group when possible so grandchildren that
// ignore SIGTERM (or outlive the leader) are still reaped; fall back to the
// direct child when the pid is unavailable (e.g. a test double). ESRCH means
// the group is already gone — treat as success.
const killGroup = (child: SpawnedProcess, signal: NodeJS.Signals): boolean => {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      return child.kill(signal);
    }
  }
  return child.kill(signal);
};

type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnLaunchOptions,
) => SpawnedProcess;

interface SpawnAgentOptions {
  cwd: string;
  signal?: AbortSignal;
  spawnFn?: SpawnFunction;
  onUpdate?: (text: string) => void;
  observe?: (observation: ChildObservation) => void;
  termGraceMs?: number;
}

interface SpawnResult {
  agent: string;
  task: string;
  exitCode: number | null;
  output: string;
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  permissionBlocked?: true;
  signal?: string;
  failed: boolean;
}

interface ProcessOutcome {
  exitCode: number | null;
  signal?: string;
}

const defaultSpawn: SpawnFunction = (command, args, options) =>
  spawn(command, args, options);

const capText = (value: string, cap: number = PER_TASK_OUTPUT_CAP): string => {
  if (Buffer.byteLength(value, "utf8") <= cap) return value;

  const contentCap = Math.max(0, cap - Buffer.byteLength(TRUNCATION_MARKER));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentCap) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let end = low;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 55_296 && lastCodeUnit <= 56_319) end -= 1;
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
};

const createCappedAccumulator = () => {
  let value = "";
  let truncated = false;
  return {
    append(chunk: string) {
      if (truncated || chunk === "") return;
      const combined = `${value}${chunk}`;
      truncated = Buffer.byteLength(combined, "utf8") > PER_TASK_OUTPUT_CAP;
      value = capText(combined);
    },
    getValue: () => value,
  };
};

const longestPatternPrefixAtEnd = (value: string, pattern: string): number => {
  const maximum = Math.min(value.length, pattern.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(pattern.slice(0, length))) return length;
  }
  return 0;
};

const writePromptToTempFile = async (
  agentName: string,
  prompt: string,
): Promise<{ directory: string; filePath: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(directory, `prompt-${safeName}.md`);
  try {
    await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
  return { directory, filePath };
};

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && "aborted" in signal && signal.aborted === true;

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
};

const spawnAgent = async (
  agent: AgentDefinition,
  task: string,
  options: SpawnAgentOptions,
): Promise<SpawnResult> => {
  if (isAborted(options.signal)) throw new Error("Subagent was aborted");
  const args = ["--mode", "json", "-p", "--no-session"];
  if (agent.model !== undefined) args.push("--model", agent.model);
  if (agent.tools !== undefined && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  let promptDirectory: string | undefined;
  try {
    if (agent.systemPrompt.trim() !== "") {
      const promptFile = await writePromptToTempFile(
        agent.name,
        agent.systemPrompt,
      );
      promptDirectory = promptFile.directory;
      args.push("--append-system-prompt", promptFile.filePath);
    }
    if (isAborted(options.signal)) throw new Error("Subagent was aborted");
    args.push(`Task: ${task}`);

    const spawnFn = options.spawnFn ?? defaultSpawn;
    const permissionSignalToken = randomUUID();
    const permissionSignal = formatChildPermissionSignal(permissionSignalToken);
    if (permissionSignal === undefined) {
      throw new Error("Failed to create a child permission signal");
    }
    const permissionSignalFrame = `${permissionSignal}\n`;
    const stderrAccumulator = createCappedAccumulator();
    let output = "";
    let buffer = "";
    let stderrControlBuffer = "";
    let skippingOversizedLine = false;
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const observe = (observation: ChildObservation): void => {
      try {
        options.observe?.(observation);
      } catch {
        // Browser instrumentation must not affect child execution.
      }
    };
    const protocol = createChildProtocolParser({ observe });
    let aborted = false;
    let abortHandler: (() => void) | undefined;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let permissionBlocked = false;

    let outcome: ProcessOutcome;
    try {
      outcome = await new Promise<ProcessOutcome>((resolve, reject) => {
        let settled = false;
        let closed = false;
        let sigkillSent = false;
        let termTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTermTimer = () => {
          if (termTimer === undefined) return;
          clearTimeout(termTimer);
          termTimer = undefined;
        };
        const settle = (value: ProcessOutcome) => {
          if (settled) return;
          settled = true;
          clearTermTimer();
          resolve(value);
        };

        let child: SpawnedProcess;
        try {
          child = spawnFn("pi", args, {
            cwd: options.cwd,
            env: sanitizeChildEnv(
              process.env,
              {
                PI_HARNESS_CHILD: "1",
                [CHILD_PERMISSION_SIGNAL_ENV]: permissionSignalToken,
              },
              { cwd: options.cwd },
            ),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
        } catch (error) {
          // Synchronous spawn failures flow into tool results; cap the
          // message like every other returned text.
          reject(new Error(capText(String(error))));
          return;
        }

        observe({ type: "process_started", at: Date.now() });

        const processLine = (line: string) => {
          const event = protocol.processLine(line);
          if (event === undefined) return;
          if (event.stopReason !== undefined) {
            stopReason = capText(event.stopReason);
          }
          if (event.errorMessage !== undefined) {
            errorMessage = capText(event.errorMessage);
          }
          if (event.text === undefined) return;
          output = capText(event.text);
          options.onUpdate?.(output);
        };

        const processDecodedChunk = (decoded: string) => {
          let remaining = decoded;
          while (remaining !== "") {
            if (skippingOversizedLine) {
              const newlineIndex = remaining.indexOf("\n");
              if (newlineIndex === -1) return;
              skippingOversizedLine = false;
              remaining = remaining.slice(newlineIndex + 1);
              continue;
            }

            const newlineIndex = remaining.indexOf("\n");
            if (newlineIndex !== -1) {
              const line = `${buffer}${remaining.slice(0, newlineIndex)}`;
              // Drop complete oversized lines before parsing so the cap
              // bounds transient allocations too, not just retained state.
              if (Buffer.byteLength(line, "utf8") <= LINE_DROP_CAP) {
                processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
              } else protocol.oversizedLine();
              buffer = "";
              remaining = remaining.slice(newlineIndex + 1);
              continue;
            }

            const candidate = `${buffer}${remaining}`;
            if (Buffer.byteLength(candidate, "utf8") > LINE_DROP_CAP) {
              buffer = "";
              skippingOversizedLine = true;
              protocol.oversizedLine();
            } else {
              buffer = candidate;
            }
            return;
          }
        };

        const processStderrDecodedChunk = (decoded: string) => {
          const combined = `${stderrControlBuffer}${decoded}`;
          let cursor = 0;
          let signalIndex = combined.indexOf(permissionSignalFrame, cursor);
          while (signalIndex !== -1) {
            stderrAccumulator.append(combined.slice(cursor, signalIndex));
            permissionBlocked = true;
            cursor = signalIndex + permissionSignalFrame.length;
            signalIndex = combined.indexOf(permissionSignalFrame, cursor);
          }

          const remaining = combined.slice(cursor);
          const retainedLength = longestPatternPrefixAtEnd(
            remaining,
            permissionSignalFrame,
          );
          const retainedStart = remaining.length - retainedLength;
          stderrAccumulator.append(remaining.slice(0, retainedStart));
          // Retain only a possible control-frame prefix. This bounds parser
          // memory while recognizing a frame split across arbitrary chunks.
          stderrControlBuffer = remaining.slice(retainedStart);
        };

        const finishStderr = () => {
          // writeSync emits a newline-terminated frame atomically, but also
          // redact an authenticated final partial frame if the pipe closes at
          // exactly the wrong moment. Never retain the per-spawn token.
          let cursor = 0;
          let signalIndex = stderrControlBuffer.indexOf(
            permissionSignal,
            cursor,
          );
          while (signalIndex !== -1) {
            stderrAccumulator.append(
              stderrControlBuffer.slice(cursor, signalIndex),
            );
            permissionBlocked = true;
            cursor = signalIndex + permissionSignal.length;
            signalIndex = stderrControlBuffer.indexOf(permissionSignal, cursor);
          }
          stderrAccumulator.append(stderrControlBuffer.slice(cursor));
          stderrControlBuffer = "";
        };

        const forceKill = () => {
          if (settled || sigkillSent) return;
          sigkillSent = true;
          if (!killGroup(child, "SIGKILL")) {
            stderrAccumulator.append(
              "Failed to terminate subagent with SIGKILL.",
            );
            settle({ exitCode: null, signal: "SIGKILL" });
            return;
          }
          // A broken child-process adapter may never emit close even after the
          // process group is gone. Bound abort draining so session shutdown and
          // tree navigation cannot hang forever.
          const settleTimer = setTimeout(
            () => settle({ exitCode: null, signal: "SIGKILL" }),
            100,
          );
          unrefTimer(settleTimer);
        };

        abortHandler = () => {
          if (aborted || settled) return;
          aborted = true;
          if (!killGroup(child, "SIGTERM")) {
            forceKill();
            return;
          }
          if (closed || settled) return;
          const graceMs = Math.max(0, options.termGraceMs ?? SIGTERM_GRACE_MS);
          termTimer = setTimeout(forceKill, graceMs);
          unrefTimer(termTimer);
        };

        child.stdout.on("data", (chunk) => {
          processDecodedChunk(
            typeof chunk === "string"
              ? chunk
              : decoder.write(Buffer.from(chunk)),
          );
        });
        child.stderr.on("data", (chunk) => {
          processStderrDecodedChunk(
            typeof chunk === "string"
              ? chunk
              : stderrDecoder.write(Buffer.from(chunk)),
          );
        });
        child.on("close", (code, signal) => {
          closed = true;
          const finalDecoded = decoder.end();
          if (finalDecoded !== "") processDecodedChunk(finalDecoded);
          if (!skippingOversizedLine && buffer.trim() !== "") {
            processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
          }
          const finalStderrDecoded = stderrDecoder.end();
          if (finalStderrDecoded !== "") {
            processStderrDecodedChunk(finalStderrDecoded);
          }
          finishStderr();
          observe({
            type: "process_exit",
            at: Date.now(),
            exitCode: code,
            signal: signal ?? undefined,
          });
          // On abort the leader can exit while SIGTERM-ignoring grandchildren
          // linger in its process group; SIGKILL the group to reap them,
          // independent of the leader's close.
          if (aborted && !sigkillSent) {
            sigkillSent = true;
            killGroup(child, "SIGKILL");
          }
          settle({ exitCode: code, signal: signal ?? undefined });
        });
        child.on("error", (error) => {
          stderrAccumulator.append(error.message);
          observe({
            type: "process_exit",
            at: Date.now(),
            exitCode: 1,
          });
          settle({ exitCode: 1 });
        });

        if (isAborted(options.signal)) {
          abortHandler();
        } else if (
          options.signal !== undefined &&
          "addEventListener" in options.signal &&
          typeof options.signal.addEventListener === "function"
        ) {
          options.signal.addEventListener("abort", abortHandler, {
            once: true,
          });
        }
      });
    } finally {
      if (
        abortHandler !== undefined &&
        options.signal !== undefined &&
        "removeEventListener" in options.signal &&
        typeof options.signal.removeEventListener === "function"
      ) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }

    if (aborted) throw new Error("Subagent was aborted");

    const failedStopReason =
      stopReason !== undefined && FAILED_STOP_REASONS.has(stopReason);
    const failed =
      outcome.exitCode === null ||
      outcome.exitCode !== 0 ||
      failedStopReason ||
      permissionBlocked;
    return {
      agent: capText(agent.name),
      task: capText(task),
      exitCode: outcome.exitCode,
      output,
      stderr: stderrAccumulator.getValue(),
      model: agent.model === undefined ? undefined : capText(agent.model),
      stopReason,
      errorMessage,
      ...(permissionBlocked ? { permissionBlocked: true as const } : {}),
      signal: outcome.signal,
      failed,
    };
  } finally {
    if (promptDirectory !== undefined) {
      await rm(promptDirectory, { recursive: true, force: true });
    }
  }
};

export { capText, PER_TASK_OUTPUT_CAP, spawnAgent };
export type {
  SpawnAgentOptions,
  SpawnFunction,
  SpawnLaunchOptions,
  SpawnResult,
  SpawnedProcess,
};
