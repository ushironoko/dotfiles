import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiInstallation } from "./installation";
import { StrictJsonlDecoder, terminateProcessGroup } from "./process";

const EXPECTED_TOOLS = [
  "subagent",
  "workflow",
  "worktree_create",
  "worktree_remove",
  "task_completed",
  "AskUserQuestion",
  "web_search",
  "web_fetch",
];

export interface RpcSmokeOptions {
  repoRoot: string;
  timeoutMs?: number;
  keepTemp?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const appendBounded = (current: string, chunk: string, max = 256 * 1024) => {
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined) <= max) return combined;
  return Buffer.from(combined).subarray(0, max).toString("utf8");
};

const probeSource = (command: string, marker: string): string => `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function compatProbe(pi: ExtensionAPI): void {
  pi.registerProvider("pi-compat-smoke", {
    name: "pi compatibility smoke (never invoked)",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "compat-smoke-never-send",
    api: "openai-responses",
    models: [{
      id: "never-invoked",
      name: "Compatibility Smoke",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 64,
    }],
  });

  pi.registerCommand(${JSON.stringify(command)}, {
    description: "Internal compatibility probe",
    handler: async (_args, ctx) => {
      const tools = new Set(pi.getAllTools().map((tool) => tool.name));
      const missing = ${JSON.stringify(EXPECTED_TOOLS)}.filter((name) => !tools.has(name));
      if (missing.length > 0) throw new Error("missing tools: " + missing.join(", "));
      if (ctx.mode !== "rpc" || !ctx.hasUI || typeof ctx.shutdown !== "function") {
        throw new Error("incompatible extension context");
      }
      ctx.ui.notify(${JSON.stringify(marker)}, "info");
      ctx.shutdown();
    },
  });
}
`;

export const smokeGlobalPiRpc = async (
  installation: PiInstallation,
  options: RpcSmokeOptions,
): Promise<void> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-compat-rpc-"));
  const nonce = crypto.randomUUID();
  const command = `pi-compat-${nonce}`;
  const marker = `PI_COMPAT_OK:${nonce}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const home = join(tempRoot, "home");
    const agentDir = join(tempRoot, "agent");
    const cwd = join(tempRoot, "cwd");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);
    const probe = join(tempRoot, "probe.ts");
    await writeFile(probe, probeSource(command, marker), { mode: 0o600 });

    const args = [
      installation.binaryRealPath,
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--provider",
      "pi-compat-smoke",
      "--model",
      "never-invoked",
      "-e",
      join(options.repoRoot, "pi/extensions/pi-harness/index.ts"),
      "-e",
      join(options.repoRoot, "pi/extensions/codex-web/index.ts"),
      "-e",
      probe,
    ];
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      TMPDIR: tempRoot,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(tempRoot, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      LANG: "C.UTF-8",
    };
    child = spawn(installation.bunExecutable, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { stdin, stdout, stderr: stderrStream } = child;
    if (stdin === null || stdout === null || stderrStream === null) {
      throw new Error("pi RPC pipes were not created");
    }

    const decoder = new StrictJsonlDecoder();
    let stderr = "";
    let commandFound = false;
    let markerFound = false;
    let promptSucceeded = false;
    let failure: Error | undefined;
    const setFailure = (error: Error) => {
      failure ??= error;
    };
    const sendRpc = (payload: Record<string, unknown>): void => {
      if (stdin.destroyed || !stdin.writable) {
        setFailure(new Error("pi RPC stdin closed before request"));
        return;
      }
      stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error !== null && error !== undefined) setFailure(error);
      });
    };
    stdin.on("error", (error) => setFailure(error));

    stderrStream.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    stdout.on("data", (chunk: Buffer | string) => {
      try {
        for (const raw of decoder.push(chunk)) {
          if (!isRecord(raw)) continue;
          const type = raw.type;
          if (type === "extension_error") {
            setFailure(new Error(`pi extension error: ${JSON.stringify(raw)}`));
          }
          if (
            type === "agent_start" ||
            type === "turn_start" ||
            type === "before_provider_request"
          ) {
            setFailure(
              new Error(`compatibility probe reached agent/provider: ${type}`),
            );
          }
          if (
            type === "extension_ui_request" &&
            raw.method === "notify" &&
            raw.message === marker
          ) {
            markerFound = true;
          }
          if (type !== "response") continue;
          if (raw.id === "commands") {
            const data = raw.data;
            const commands =
              isRecord(data) && Array.isArray(data.commands)
                ? data.commands
                : [];
            commandFound = commands.some(
              (item) => isRecord(item) && item.name === command,
            );
            if (!commandFound) {
              setFailure(new Error("compatibility probe command did not load"));
              terminateProcessGroup(child?.pid, "SIGTERM");
              continue;
            }
            sendRpc({
              id: "probe",
              type: "prompt",
              message: `/${command}`,
            });
          } else if (raw.id === "probe") {
            promptSucceeded = raw.success === true;
            if (!promptSucceeded) {
              setFailure(
                new Error(
                  `compatibility probe command failed: ${JSON.stringify(raw)}`,
                ),
              );
            }
          }
        }
      } catch (error) {
        setFailure(error instanceof Error ? error : new Error(String(error)));
        terminateProcessGroup(child?.pid, "SIGTERM");
      }
    });

    sendRpc({ id: "commands", type: "get_commands" });

    const timeoutMs = options.timeoutMs ?? 15_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, rejectExit) => {
          child?.once("error", rejectExit);
          child?.once("close", (code, signal) => resolveExit({ code, signal }));
        },
      ),
      new Promise<never>((_, rejectTimeout) => {
        timeout = setTimeout(() => {
          terminateProcessGroup(child?.pid, "SIGTERM");
          rejectTimeout(new Error("pi RPC compatibility smoke timed out"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });

    try {
      decoder.finish();
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)));
    }
    if (failure !== undefined) throw failure;
    if (!commandFound || !markerFound || !promptSucceeded) {
      throw new Error(
        `pi RPC compatibility probe incomplete: command=${commandFound} marker=${markerFound} response=${promptSucceeded} stderr=${stderr}`,
      );
    }
    if (exit.code !== 0 && exit.signal === null) {
      throw new Error(`pi RPC exited ${exit.code}: ${stderr}`);
    }
    if (/extension|failed|error/i.test(stderr)) {
      throw new Error(`pi RPC reported startup diagnostics: ${stderr}`);
    }
  } finally {
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      terminateProcessGroup(child.pid, "SIGTERM");
      await Bun.sleep(200);
      if (child.exitCode === null && child.signalCode === null) {
        terminateProcessGroup(child.pid, "SIGKILL");
        await Bun.sleep(50);
      }
    }
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
  }
};
