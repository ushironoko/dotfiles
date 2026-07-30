import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  assertNoLocalPiResolution,
  PI_HARNESS_RUNTIME_PACKAGES,
} from "../../scripts/pi-compat/compile";
import { PI_BASELINE_PACKAGES } from "../../scripts/pi-compat/baseline";
import { checkPiCompatibility } from "../../scripts/pi-compat/index";
import {
  discoverPiInstallation,
  satisfiesManifestRange,
  type PiInstallation,
} from "../../scripts/pi-compat/installation";
import {
  runCommand,
  StrictJsonlDecoder,
} from "../../scripts/pi-compat/process";

const installation = (version = "0.99.0"): PiInstallation => ({
  bunExecutable: "/tools/bun",
  globalBin: "/global/bin",
  binaryPath: "/global/bin/pi",
  binaryRealPath:
    "/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  packageRoot: "/global/node_modules/@earendil-works/pi-coding-agent",
  packageName: "@earendil-works/pi-coding-agent",
  packageVersion: version,
  corePackages: {
    "@earendil-works/pi-coding-agent": {
      root: "/global/node_modules/@earendil-works/pi-coding-agent",
      version,
      manifest: {},
    },
    "@earendil-works/pi-ai": {
      root: "/global/node_modules/@earendil-works/pi-ai",
      version,
      manifest: {},
    },
    "@earendil-works/pi-agent-core": {
      root: "/global/node_modules/@earendil-works/pi-agent-core",
      version,
      manifest: {},
    },
    "@earendil-works/pi-tui": {
      root: "/global/node_modules/@earendil-works/pi-tui",
      version,
      manifest: {},
    },
    typebox: {
      root: "/global/node_modules/typebox",
      version: "1.1.38",
      manifest: {},
    },
  },
});

describe("pi compatibility policy", () => {
  test("accepts global version drift when compile and runtime contracts pass", async () => {
    const calls: string[] = [];
    const result = await checkPiCompatibility("/repo", {
      checkBaseline: async () => ({
        ok: true,
        issues: [],
        packages: [
          {
            name: "@earendil-works/pi-coding-agent",
            lockedVersion: "0.80.7",
          },
        ],
      }),
      discover: async () => installation("0.99.0"),
      compile: async () => {
        calls.push("compile");
      },
      smoke: async () => {
        calls.push("smoke");
      },
    });

    expect(result.installation.packageVersion).toBe("0.99.0");
    expect(calls).toEqual(["compile", "smoke"]);
  });

  test("stops before discovery when the local baseline is stale", async () => {
    let discovered = false;
    await expect(
      checkPiCompatibility("/repo", {
        checkBaseline: async () => {
          throw new Error("stale baseline");
        },
        discover: async () => {
          discovered = true;
          return installation();
        },
      }),
    ).rejects.toThrow("stale baseline");
    expect(discovered).toBe(false);
  });
});

describe("global pi installation discovery", () => {
  test("uses the non-project pi on PATH when sandbox cache isolation breaks Bun global discovery", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-installation-"));
    try {
      const localModules = join(root, "repo", "node_modules");
      const localBin = join(localModules, ".bin");
      await mkdir(localBin, { recursive: true });
      await writeFile(join(localBin, "pi"), "#!/bin/sh\nexit 0\n");
      await chmod(join(localBin, "pi"), 0o755);

      const globalRoot = join(root, "global");
      const globalModules = join(globalRoot, "node_modules");
      const packageVersion = "0.83.0";
      let codingAgentRoot = "";
      for (const name of PI_BASELINE_PACKAGES) {
        const packageRoot = join(globalModules, ...name.split("/"));
        const version = name === "typebox" ? "1.3.7" : packageVersion;
        await mkdir(packageRoot, { recursive: true });
        const manifest: Record<string, unknown> = { name, version };
        if (name === "@earendil-works/pi-coding-agent") {
          codingAgentRoot = packageRoot;
          manifest.bin = { pi: "dist/cli.js" };
          await mkdir(join(packageRoot, "dist"), { recursive: true });
          await writeFile(
            join(packageRoot, "dist/cli.js"),
            "#!/usr/bin/env node\n",
          );
          await chmod(join(packageRoot, "dist/cli.js"), 0o755);
        }
        await writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify(manifest),
        );
      }

      const globalBin = join(globalRoot, "bin");
      await mkdir(globalBin, { recursive: true });
      await symlink(
        join(codingAgentRoot, "dist/cli.js"),
        join(globalBin, "pi"),
      );

      const calls: string[][] = [];
      const discovered = await discoverPiInstallation({
        bunExecutable: "/tools/bun",
        environment: {
          PATH: `${localBin}${delimiter}${globalBin}`,
          XDG_CACHE_HOME: join(root, "sandbox-cache"),
        },
        excludedPackageRoots: [localModules],
        run: async (argv) => {
          calls.push([...argv]);
          return {
            argv: [...argv],
            exitCode: 0,
            stdout: `${packageVersion}\n`,
            stderr: "",
            timedOut: false,
            truncated: false,
          };
        },
      });

      expect(discovered.binaryPath).toBe(join(globalBin, "pi"));
      expect(discovered.packageVersion).toBe(packageVersion);
      expect(calls).toEqual([[join(globalBin, "pi"), "--version"]]);

      const aliasBin = join(root, "alias-bin");
      await mkdir(aliasBin);
      await symlink(join(codingAgentRoot, "dist/cli.js"), join(aliasBin, "pi"));
      await expect(
        discoverPiInstallation({
          environment: { PATH: aliasBin },
          excludedPackageRoots: [codingAgentRoot],
          run: async (argv) => {
            if (argv[1] !== "pm") {
              throw new Error("version command must not run");
            }
            return {
              argv: [...argv],
              exitCode: 0,
              stdout: `${aliasBin}\n`,
              stderr: "",
              timedOut: false,
              truncated: false,
            };
          },
        }),
      ).rejects.toThrow("excluded package root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("strict pi RPC JSONL framing", () => {
  test("handles fragmented UTF-8 and keeps Unicode line separators inside JSON", () => {
    const decoder = new StrictJsonlDecoder();
    const bytes = Buffer.from('{"text":"a\u2028b😀"}\n{"ok":true}\r\n');
    const split = bytes.indexOf(Buffer.from("😀")) + 1;
    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(decoder.push(bytes.subarray(split))).toEqual([
      { text: "a\u2028b😀" },
      { ok: true },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  test("fails closed on malformed, oversized, incomplete, and excess records", () => {
    expect(() => new StrictJsonlDecoder().push("not-json\n")).toThrow(
      "malformed",
    );
    expect(() =>
      new StrictJsonlDecoder({ maxLineBytes: 2 }).push('{"x":1}'),
    ).toThrow("byte limit");
    const incomplete = new StrictJsonlDecoder();
    incomplete.push('{"x":1}');
    expect(() => incomplete.finish()).toThrow("incomplete");
    expect(() =>
      new StrictJsonlDecoder({ maxRecords: 1 }).push("{}\n{}\n"),
    ).toThrow("record count");
  });
});

describe("bounded compatibility subprocesses", () => {
  test("a timeout kills the spawned process group before returning", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-process-group-"));
    const pidFile = join(root, "grandchild.pid");
    try {
      const command = `(trap '' TERM; echo $BASHPID > ${JSON.stringify(pidFile)}; while true; do sleep 1; done) & wait`;
      const commandResult = await runCommand(["bash", "-c", command], {
        timeoutMs: 20,
      });
      expect(commandResult.timedOut).toBe(true);
      const pidText = await readFile(pidFile, "utf8");
      const pid = Number(pidText.trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("global declaration resolution guard", () => {
  test("rejects repository-local pi declarations", () => {
    expect(() =>
      assertNoLocalPiResolution(
        [join("/repo", "node_modules/@earendil-works/pi-tui/dist/index.d.ts")],
        "/repo",
        installation(),
      ),
    ).toThrow("repository-local");
  });

  test("accepts global pi declarations and the deployed local runtime closure", () => {
    expect(() =>
      assertNoLocalPiResolution(
        [
          "/global/node_modules/@earendil-works/pi-tui/dist/index.d.ts",
          "/repo/node_modules/@anthropic-ai/sandbox-runtime/dist/index.d.ts",
        ],
        "/repo",
        installation(),
      ),
    ).not.toThrow();
    expect(PI_HARNESS_RUNTIME_PACKAGES).toEqual([
      "@anthropic-ai/sandbox-runtime",
      "@pondwader/socks5-server",
      "commander",
      "lodash-es",
      "shell-quote",
      "zod",
    ]);
  });
});

describe("pi manifest ranges", () => {
  test("supports exact and caret ranges used by the pi package cohort", () => {
    expect(satisfiesManifestRange("0.80.9", "^0.80.7")).toBe(true);
    expect(satisfiesManifestRange("0.81.0", "^0.80.7")).toBe(false);
    expect(satisfiesManifestRange("1.4.0", "^1.2.3")).toBe(true);
    expect(satisfiesManifestRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesManifestRange("1.1.38", "1.1.38")).toBe(true);
  });
});
