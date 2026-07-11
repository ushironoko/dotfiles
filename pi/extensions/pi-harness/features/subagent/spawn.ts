import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../../lib/agent-md";

const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Parser-protection ceiling: lines beyond this are dropped unparsed. Kept
// above PER_TASK_OUTPUT_CAP so oversized-but-parseable payloads still get
// capped text with the truncation marker instead of disappearing.
const LINE_DROP_CAP = PER_TASK_OUTPUT_CAP * 4;
const SIGTERM_GRACE_MS = 2000;
const TRUNCATION_MARKER = "\n\n[Output truncated.]";

interface ReadableLike {
  on(event: "data", listener: (chunk: string) => void): ReadableLike;
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
}

interface SpawnLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

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
  signal?: string;
  failed: boolean;
}

interface MessageEndEvent {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (
  primary: Record<string, unknown>,
  secondary: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const primaryValue = primary[key];
  if (typeof primaryValue === "string") return capText(primaryValue);
  const secondaryValue = secondary?.[key];
  return typeof secondaryValue === "string"
    ? capText(secondaryValue)
    : undefined;
};

const parseMessageEndEvent = (line: string): MessageEndEvent | undefined => {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== "message_end") return undefined;
  const message = isRecord(event.message) ? event.message : undefined;
  const parsed: MessageEndEvent = {
    stopReason: getString(event, message, "stopReason"),
    errorMessage: getString(event, message, "errorMessage"),
  };

  if (message?.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        parsed.text = capText(part.text);
        break;
      }
    }
  }
  return parsed;
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
    args.push(`Task: ${task}`);

    const spawnFn = options.spawnFn ?? defaultSpawn;
    const stderrAccumulator = createCappedAccumulator();
    let output = "";
    let buffer = "";
    let skippingOversizedLine = false;
    let aborted = false;
    let abortHandler: (() => void) | undefined;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    let outcome: ProcessOutcome;
    try {
      outcome = await new Promise<ProcessOutcome>((resolve, reject) => {
        let settled = false;
        let closed = false;
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
            env: { ...process.env, PI_HARNESS_CHILD: "1" },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          // Synchronous spawn failures flow into tool results; cap the
          // message like every other returned text.
          reject(new Error(capText(String(error))));
          return;
        }

        const processLine = (line: string) => {
          if (line.trim() === "") return;
          const event = parseMessageEndEvent(line);
          if (event === undefined) return;
          const {
            stopReason: eventStopReason,
            errorMessage: eventErrorMessage,
            text,
          } = event;
          if (eventStopReason !== undefined) stopReason = eventStopReason;
          if (eventErrorMessage !== undefined) errorMessage = eventErrorMessage;
          if (text === undefined) return;
          output = text;
          options.onUpdate?.(text);
        };

        const processStdoutChunk = (chunk: string) => {
          let remaining = chunk.toString();
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
                processLine(line);
              }
              buffer = "";
              remaining = remaining.slice(newlineIndex + 1);
              continue;
            }

            const candidate = `${buffer}${remaining}`;
            if (Buffer.byteLength(candidate, "utf8") > LINE_DROP_CAP) {
              buffer = "";
              skippingOversizedLine = true;
            } else {
              buffer = candidate;
            }
            return;
          }
        };

        const forceKill = () => {
          if (closed || settled) return;
          if (!child.kill("SIGKILL")) {
            stderrAccumulator.append(
              "Failed to terminate subagent with SIGKILL.",
            );
            settle({ exitCode: null, signal: "SIGKILL" });
          }
        };

        abortHandler = () => {
          if (aborted || settled) return;
          aborted = true;
          if (!child.kill("SIGTERM")) {
            forceKill();
            return;
          }
          if (closed || settled) return;
          const graceMs = Math.max(0, options.termGraceMs ?? SIGTERM_GRACE_MS);
          termTimer = setTimeout(forceKill, graceMs);
          unrefTimer(termTimer);
        };

        child.stdout.on("data", processStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrAccumulator.append(chunk.toString());
        });
        child.on("close", (code, signal) => {
          closed = true;
          if (!skippingOversizedLine && buffer.trim() !== "") {
            processLine(buffer);
          }
          settle({ exitCode: code, signal: signal ?? undefined });
        });
        child.on("error", (error) => {
          stderrAccumulator.append(error.message);
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

    const failedStopReason = stopReason === "error" || stopReason === "aborted";
    const failed =
      outcome.exitCode === null || outcome.exitCode !== 0 || failedStopReason;
    return {
      agent: capText(agent.name),
      task: capText(task),
      exitCode: outcome.exitCode,
      output,
      stderr: stderrAccumulator.getValue(),
      model: agent.model === undefined ? undefined : capText(agent.model),
      stopReason,
      errorMessage,
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
