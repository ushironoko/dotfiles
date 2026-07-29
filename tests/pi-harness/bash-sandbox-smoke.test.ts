import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  CONTROLLED_BASH_PATH,
  createControlledBashOperations,
} from "../../pi/extensions/pi-harness/features/bash-sandbox/runtime";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";

const commandAvailable = (command: string): boolean =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

const requiredCommands = (): readonly string[] => {
  if (process.platform === "linux") return ["bwrap", "socat", "rg"];
  if (process.platform === "darwin") return ["rg"];
  return [];
};
const missingCommands = requiredCommands().filter(
  (command) => !commandAvailable(command),
);
const unavailableReason = (): string | undefined => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return `unsupported platform ${process.platform}`;
  }
  return missingCommands.length > 0
    ? `missing ${missingCommands.join(", ")}`
    : undefined;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const smokeUnavailable = unavailableReason();

describe.skipIf(smokeUnavailable !== undefined)(
  `real Bash sandbox (${smokeUnavailable ?? process.platform})`,
  () => {
    test("enforces write, read, symlink, network, and outer-shell boundaries", async () => {
      const root = await setupTestDirectory("pi-bash-sandbox-smoke");
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      const scratch = join(root, "scratch");
      const home = join(root, "home");
      const allowedFile = join(workspace, "allowed.txt");
      const blockedFile = join(outside, "blocked.txt");
      const escapedFile = join(outside, "escaped.txt");
      const secretFile = join(outside, "credential.txt");
      const commonGit = join(workspace, "common-git");
      const protectedConfig = join(commonGit, "config");
      const protectedHooks = join(commonGit, "hooks");
      const protectedHook = join(protectedHooks, "pre-commit");
      const startupFile = join(root, "bash-env.sh");
      const startupCanary = join(outside, "startup-canary.txt");
      let server: ReturnType<typeof Bun.serve> | undefined;

      try {
        await Promise.all(
          [workspace, outside, scratch, home, protectedHooks].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        await writeFile(secretFile, "credential-canary", "utf8");
        await writeFile(protectedConfig, "protected-config", "utf8");
        await writeFile(
          startupFile,
          `printf compromised > ${shellQuote(startupCanary)}\n`,
          "utf8",
        );
        await symlink(outside, join(workspace, "escape"));

        const runtimeConfig: SandboxRuntimeConfig = {
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
          },
          filesystem: {
            denyRead: [secretFile],
            allowWrite: [workspace, scratch],
            denyWrite: [outside, protectedConfig, protectedHooks],
            allowGitConfig: false,
          },
          enableWeakerNestedSandbox: false,
          mandatoryDenySearchDepth: 5,
        };
        await SandboxManager.initialize(
          runtimeConfig,
          async () => false,
          false,
        );

        const operations = createControlledBashOperations({
          getScratchDirectory: () => scratch,
          baseEnv: {
            HOME: home,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            BASH_ENV: startupFile,
          },
          wrapCommand: (command, signal) =>
            SandboxManager.wrapWithSandbox(
              command,
              CONTROLLED_BASH_PATH,
              undefined,
              signal,
            ),
        });
        const run = async (command: string) => {
          let output = "";
          const result = await operations.exec(command, workspace, {
            onData: (chunk) => {
              output += chunk.toString();
            },
            timeout: 5,
          });
          return { exitCode: result.exitCode, output };
        };

        expect(
          await run(`printf allowed > ${shellQuote(allowedFile)}`),
        ).toMatchObject({ exitCode: 0 });
        expect(await readFile(allowedFile, "utf8")).toBe("allowed");

        const blockedWrite = await run(
          `printf blocked > ${shellQuote(blockedFile)}`,
        );
        expect(blockedWrite.exitCode).not.toBe(0);
        expect(await pathExists(blockedFile)).toBe(false);

        const deniedRead = await run(`cat ${shellQuote(secretFile)}`);
        expect(deniedRead.exitCode).not.toBe(0);
        expect(deniedRead.output).not.toContain("credential-canary");

        const protectedConfigWrite = await run(
          `printf replaced > ${shellQuote(protectedConfig)}`,
        );
        expect(protectedConfigWrite.exitCode).not.toBe(0);
        expect(await readFile(protectedConfig, "utf8")).toBe(
          "protected-config",
        );
        const protectedHookWrite = await run(
          `printf hook > ${shellQuote(protectedHook)}`,
        );
        expect(protectedHookWrite.exitCode).not.toBe(0);
        expect(await pathExists(protectedHook)).toBe(false);

        const escapedWrite = await run(
          `printf escaped > ${shellQuote(join(workspace, "escape", "escaped.txt"))}`,
        );
        expect(escapedWrite.exitCode).not.toBe(0);
        expect(await pathExists(escapedFile)).toBe(false);

        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response("host reachable"),
        });
        const hostResponse = await fetch(server.url);
        expect(await hostResponse.text()).toBe("host reachable");
        const networkAttempt = await run(
          `printf ping > /dev/tcp/127.0.0.1/${String(server.port)}`,
        );
        expect(networkAttempt.exitCode).not.toBe(0);

        expect(await pathExists(startupCanary)).toBe(false);
      } finally {
        server?.stop(true);
        await SandboxManager.reset().catch(() => {});
        await cleanupTestDirectory(root);
      }
    }, 20_000);
  },
);
