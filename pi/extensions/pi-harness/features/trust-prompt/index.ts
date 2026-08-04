import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HarnessConfig } from "../../config";
import {
  runBoundedCommand,
  type RunBoundedCommand,
} from "../../lib/bounded-process";
import { sanitizeChildEnv } from "../../lib/child-env";
import type { PiLike } from "../../lib/pi-like";
import { appendTrustedRoot, type TrustConfig } from "../../lib/trust";
import {
  MemoryRepositoryError,
  resolveMemoryRepository,
  type RunRepositoryGit,
} from "../agent-memory/repository";

const GIT_TIMEOUT_MS = 2_000;
const GIT_OUTPUT_MAX_BYTES = 64 * 1_024;
const TRUST_DISCOVERY_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PROCESS_ATTEMPT_LIMIT = 256;
const PROCESS_ATTEMPTS_KEY = Symbol.for(
  "pi-harness.trust-prompt.attempted-roots.v1",
);
const fatalDecoder = new TextDecoder(undefined, { fatal: true });

type RepositoryTrust = "trusted" | "untrusted" | "unavailable";

export interface TrustPromptDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: RunBoundedCommand;
  readonly realpath?: (path: string) => Promise<string>;
  readonly appendTrustedRoot?: (
    configFile: string,
    root: string,
  ) => TrustConfig;
  readonly attemptedRoots?: Set<string>;
  readonly repositoryTrust?: (
    cwd: string,
    trust: TrustConfig,
    runGit: RunRepositoryGit,
    resolveRealpath: (path: string) => Promise<string>,
    signal?: AbortSignal,
  ) => Promise<RepositoryTrust>;
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const processAttemptedRoots = (): Set<string> => {
  const existing: unknown = Reflect.get(globalThis, PROCESS_ATTEMPTS_KEY);
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  Reflect.set(globalThis, PROCESS_ATTEMPTS_KEY, created);
  return created;
};

const rememberAttempt = (attemptedRoots: Set<string>, root: string): void => {
  if (attemptedRoots.size >= PROCESS_ATTEMPT_LIMIT) attemptedRoots.clear();
  attemptedRoots.add(root);
};

const createGitRunner = (deps: TrustPromptDependencies): RunRepositoryGit => {
  const invoke = deps.runCommand ?? runBoundedCommand;
  return async (cwd, args, signal) => {
    const result = await invoke("git", args, {
      cwd,
      env: sanitizeChildEnv(
        deps.env ?? process.env,
        { PATH: TRUST_DISCOVERY_PATH },
        { cwd },
      ),
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
      stderrMaxBytes: GIT_OUTPUT_MAX_BYTES,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
};

const repositoryRoot = async (
  cwd: string,
  runGit: RunRepositoryGit,
  resolveRealpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  let result;
  try {
    result = await runGit(
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      signal,
    );
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) return undefined;

  let output: string;
  try {
    output = fatalDecoder.decode(result.stdout);
  } catch {
    return undefined;
  }
  let lineEndingLength = 0;
  if (output.endsWith("\r\n")) lineEndingLength = 2;
  else if (output.endsWith("\n")) lineEndingLength = 1;
  if (lineEndingLength === 0) return undefined;
  const root = output.slice(0, -lineEndingLength);
  if (
    root === "" ||
    root.includes("\n") ||
    root.includes("\r") ||
    !isAbsolute(root) ||
    hasControlCharacter(root)
  ) {
    return undefined;
  }
  try {
    return await resolveRealpath(root);
  } catch {
    return undefined;
  }
};

const defaultRepositoryTrust = async (
  cwd: string,
  trust: TrustConfig,
  runGit: RunRepositoryGit,
  resolveRealpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<RepositoryTrust> => {
  try {
    await resolveMemoryRepository(
      cwd,
      trust,
      { runGit, realpath: resolveRealpath },
      signal,
    );
    return "trusted";
  } catch (error) {
    return error instanceof MemoryRepositoryError && error.kind === "untrusted"
      ? "untrusted"
      : "unavailable";
  }
};

const errorMessage = (error: unknown): string => {
  if (error instanceof SyntaxError) {
    return "pi-harness.local.json could not be parsed";
  }
  return error instanceof Error ? error.message : String(error);
};

export default function setupTrustPrompt(
  pi: PiLike,
  config: HarnessConfig,
  deps: TrustPromptDependencies = {},
): void {
  if (config.isChild) return;

  const attemptedRoots = deps.attemptedRoots ?? processAttemptedRoots();
  const resolveRealpath = deps.realpath ?? realpath;
  const runGit = createGitRunner(deps);
  const resolveTrust = deps.repositoryTrust ?? defaultRepositoryTrust;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return;

    const cwd = ctx.cwd ?? process.cwd();
    const root = await repositoryRoot(cwd, runGit, resolveRealpath, ctx.signal);
    if (root === undefined || attemptedRoots.has(root)) return;

    const trust = await resolveTrust(
      cwd,
      config.trust,
      runGit,
      resolveRealpath,
      ctx.signal,
    );
    if (trust !== "untrusted") return;
    rememberAttempt(attemptedRoots, root);

    let allowed: boolean;
    try {
      allowed = await ctx.ui.confirm(
        "Trust this repository?",
        `Allow pi-harness to use project memory and run repository-defined checks for:\n\n${root}\n\nOnly approve repositories you trust. Approval adds this path to ~/.pi/agent/pi-harness.local.json.`,
        { signal: ctx.signal },
      );
    } catch {
      attemptedRoots.delete(root);
      return;
    }
    if (!allowed) return;

    try {
      const update = deps.appendTrustedRoot ?? appendTrustedRoot;
      const next = update(config.paths.localConfigFile, root);
      config.trust.trustedRoots.splice(
        0,
        config.trust.trustedRoots.length,
        ...next.trustedRoots,
      );
      ctx.ui.notify(`Trusted repository: ${root}`, "info");
    } catch (error) {
      attemptedRoots.delete(root);
      ctx.ui.notify(
        `Could not trust repository: ${errorMessage(error)}`,
        "error",
      );
    }
  });
}
