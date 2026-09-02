import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { PiInstallation } from "./installation";
import {
  runCommand,
  StrictJsonlDecoder,
  terminateProcessGroup,
} from "./process";

const HEARTH_TOOLS = ["read", "write", "edit", "bash", "grep"];

const EXPECTED_TOOLS = [
  ...HEARTH_TOOLS,
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
  nodeExecutable?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const appendBounded = (current: string, chunk: string, max = 256 * 1024) => {
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined) <= max) return combined;
  return Buffer.from(combined).subarray(0, max).toString("utf8");
};

export const resolveNodeExecutable = async (
  configured?: string,
): Promise<string> => {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const candidates =
    configured === undefined
      ? (process.env.PATH?.split(delimiter) ?? [])
          .filter((entry) => entry !== "")
          .map((entry) => join(entry, executable))
      : [configured];
  let commandPath: string | undefined;
  for (const candidate of candidates) {
    const executablePath = resolve(candidate);
    try {
      await access(
        executablePath,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      commandPath = executablePath;
      break;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  if (commandPath === undefined) {
    throw new Error("could not resolve the Node command for the Pi RPC smoke");
  }

  // Resolve version-manager shims while their caller environment is intact.
  // The isolated smoke environment must execute the resulting Node binary,
  // not a shim that may depend on HOME or manager-specific configuration.
  const resolution = await runCommand(
    [
      commandPath,
      "-p",
      "JSON.stringify({execPath:process.execPath,nodeVersion:process.versions.node,bunVersion:process.versions.bun??null})",
    ],
    { timeoutMs: 5_000, maxOutputBytes: 4 * 1024 },
  );
  let runtime: unknown;
  try {
    runtime = JSON.parse(resolution.stdout.trim());
  } catch {
    // Invalid output is rejected by the structured checks below.
  }
  const runtimePath = isRecord(runtime) ? runtime.execPath : undefined;
  const nodeVersion = isRecord(runtime) ? runtime.nodeVersion : undefined;
  const bunVersion = isRecord(runtime) ? runtime.bunVersion : undefined;
  if (
    resolution.timedOut ||
    resolution.exitCode !== 0 ||
    resolution.truncated ||
    typeof runtimePath !== "string" ||
    !isAbsolute(runtimePath) ||
    typeof nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(nodeVersion) ||
    bunVersion !== null
  ) {
    throw new Error(
      "could not resolve a real Node runtime for the Pi RPC smoke",
    );
  }
  const runtimeRealPath = await realpath(runtimePath);
  await access(
    runtimeRealPath,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  return runtimeRealPath;
};

const fileDigest = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
};

interface RuntimeIdentity {
  nodeRealPath: string;
  nodeDigest: string;
  piDigest: string;
}

const captureRuntimeIdentity = async (
  nodeExecutable: string,
  installation: PiInstallation,
): Promise<RuntimeIdentity> => {
  const [nodeRealPath, binaryTarget] = await Promise.all([
    realpath(nodeExecutable),
    realpath(installation.binaryPath),
  ]);
  if (binaryTarget !== installation.binaryRealPath) {
    throw new Error("Pi executable identity changed before RPC verification");
  }
  const [nodeDigest, piDigest] = await Promise.all([
    fileDigest(nodeRealPath),
    fileDigest(installation.binaryRealPath),
  ]);
  return { nodeRealPath, nodeDigest, piDigest };
};

const smokePath = (nodeExecutable: string): string => {
  const entries = [dirname(nodeExecutable)];
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec;
    if (comSpec !== undefined) entries.push(dirname(comSpec));
  } else {
    entries.push("/usr/bin", "/bin");
  }
  return [...new Set(entries)].join(delimiter);
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
      const allTools = pi.getAllTools();
      const tools = new Set(allTools.map((tool) => tool.name));
      const missing = ${JSON.stringify(EXPECTED_TOOLS)}.filter((name) => !tools.has(name));
      if (missing.length > 0) throw new Error("missing tools: " + missing.join(", "));
      const wrongBackend = ${JSON.stringify(HEARTH_TOOLS)}.filter((name) => {
        const tool = allTools.find((candidate) => candidate.name === name);
        return !tool?.sourceInfo.path.includes("hearth-tools");
      });
      if (wrongBackend.length > 0) throw new Error("non-Hearth tools: " + wrongBackend.join(", "));
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

    const nodeExecutable = await resolveNodeExecutable(options.nodeExecutable);
    const runtimeIdentity = await captureRuntimeIdentity(
      nodeExecutable,
      installation,
    );
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
      join(options.repoRoot, "pi/extensions/hearth-tools/index.ts"),
      "-e",
      join(options.repoRoot, "pi/extensions/pi-harness/index.ts"),
      "-e",
      join(options.repoRoot, "pi/extensions/codex-web/index.ts"),
      "-e",
      probe,
    ];
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: smokePath(nodeExecutable),
      TMPDIR: tempRoot,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(tempRoot, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      LANG: "C.UTF-8",
    };
    child = spawn(nodeExecutable, args, {
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
          const { type } = raw;
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
            const { data } = raw;
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
    try {
      const verifiedIdentity = await captureRuntimeIdentity(
        nodeExecutable,
        installation,
      );
      if (
        verifiedIdentity.nodeRealPath !== runtimeIdentity.nodeRealPath ||
        verifiedIdentity.nodeDigest !== runtimeIdentity.nodeDigest ||
        verifiedIdentity.piDigest !== runtimeIdentity.piDigest
      ) {
        setFailure(
          new Error("Pi or Node executable changed during RPC verification"),
        );
      }
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)));
    }
    if (failure !== undefined) throw failure;
    if (!commandFound || !markerFound || !promptSucceeded) {
      throw new Error(
        `pi RPC compatibility probe incomplete: command=${commandFound} marker=${markerFound} response=${promptSucceeded} stderr=${stderr}`,
      );
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `pi RPC exited abnormally (code=${exit.code}, signal=${exit.signal}): ${stderr}`,
      );
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
