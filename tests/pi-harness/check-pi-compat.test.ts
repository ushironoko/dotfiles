import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  assertNoLocalPiResolution,
  compileExtensionsAgainstGlobalPi,
  PI_HARNESS_RUNTIME_PACKAGES,
} from "../../scripts/pi-compat/compile";
import { PI_LEGACY_BASELINE_PACKAGES } from "../../scripts/pi-compat/baseline";
import { checkPiCompatibility } from "../../scripts/pi-compat/index";
import {
  discoverPiInstallation,
  piCohortPackagesForVersion,
  satisfiesManifestRange,
  type PiInstallation,
} from "../../scripts/pi-compat/installation";
import {
  runCommand,
  StrictJsonlDecoder,
} from "../../scripts/pi-compat/process";
import {
  resolveNodeExecutable,
  smokeGlobalPiRpc,
} from "../../scripts/pi-compat/rpc-smoke";

const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

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
    "@earendil-works/pi-client": {
      root: "/global/node_modules/@earendil-works/pi-client",
      version,
      manifest: {},
    },
    "@earendil-works/pi-protocol": {
      root: "/global/node_modules/@earendil-works/pi-protocol",
      version,
      manifest: {},
    },
    "@earendil-works/pi-telemetry": {
      root: "/global/node_modules/@earendil-works/pi-telemetry",
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

const withSchemaFixture = async (
  run: (fixture: {
    repoRoot: string;
    localModules: string;
    schemaRoot: string;
    candidate: PiInstallation;
  }) => Promise<void>,
): Promise<void> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-schema-types-")),
  );
  try {
    const repoRoot = join(root, "repo");
    const localModules = join(repoRoot, "node_modules");
    const extensions = join(repoRoot, "pi/extensions");
    const globalModules = join(root, "global/node_modules");
    const schema = "@earendil-works/pi-schema";
    const schemaRoot = join(globalModules, schema);
    await Promise.all(
      [
        ...["pi-harness", "hearth-tools", "codex-web"].map((name) =>
          join(extensions, name),
        ),
        join(localModules, ".bin"),
        join(localModules, "bun-types"),
        join(schemaRoot, "dist"),
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    const repoModules = resolve(import.meta.dir, "../../node_modules");
    const compilerRoot = await realpath(
      join(repoModules, "@typescript/native-preview"),
    );
    const platformPackage = `native-preview-${process.platform}-${process.arch}`;
    const platformManifest = createRequire(
      join(compilerRoot, "package.json"),
    ).resolve(`@typescript/${platformPackage}/package.json`);
    const platformRoot = await realpath(dirname(platformManifest));
    await Promise.all([
      cp(compilerRoot, join(localModules, "@typescript/native-preview"), {
        recursive: true,
      }),
      cp(platformRoot, join(localModules, "@typescript", platformPackage), {
        recursive: true,
      }),
    ]);
    await symlink(
      "../@typescript/native-preview/bin/tsgo.js",
      join(localModules, ".bin/tsgo"),
    );
    await writeFile(join(localModules, "bun-types/index.d.ts"), "export {};");
    await writeFile(
      join(extensions, "pi-harness/index.ts"),
      `export type { Example } from "${schema}";`,
    );
    await writeFile(
      join(schemaRoot, "package.json"),
      JSON.stringify({
        name: schema,
        version: "1.6.0",
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
    );
    await writeFile(
      join(schemaRoot, "dist/index.d.ts"),
      'export type { Example } from "./part.js";',
    );
    await writeFile(
      join(schemaRoot, "dist/part.d.ts"),
      "export type Example = number;",
    );
    const candidate = installation("1.6.0");
    candidate.packageRoot = join(globalModules, candidate.packageName);
    candidate.corePackages = {
      [schema]: { root: schemaRoot, version: "1.6.0", manifest: {} },
    };
    await run({ repoRoot, localModules, schemaRoot, candidate });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

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

describe("real Pi RPC smoke launcher", () => {
  const localBundle = async (): Promise<{
    repoRoot: string;
    candidate: PiInstallation;
  }> => {
    const repoRoot = join(import.meta.dir, "../..");
    const packageRoot = join(
      repoRoot,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    const binaryRealPath = await realpath(
      join(packageRoot, "dist/bundle/cli.js"),
    );
    return {
      repoRoot,
      candidate: {
        ...installation("1.6.0"),
        binaryPath: binaryRealPath,
        binaryRealPath,
        packageRoot,
      },
    };
  };

  test("launches the verified local bundle with Node rather than Bun", async () => {
    if (process.platform === "win32") return;
    const { repoRoot, candidate } = await localBundle();
    await smokeGlobalPiRpc(candidate, { repoRoot, timeoutMs: 20_000 });
  }, 30_000);

  test("rejects Bun when it is presented as the Node command", async () => {
    await expect(resolveNodeExecutable(process.execPath)).rejects.toThrow(
      "real Node runtime",
    );
  });

  test("resolves a version-manager shim before isolating the environment", async () => {
    if (process.platform === "win32") return;
    const callerHome = process.env.HOME;
    if (callerHome === undefined) throw new Error("test HOME is unavailable");
    const root = await mkdtemp(join(tmpdir(), "pi-node-shim-"));
    try {
      const actualNode = await resolveNodeExecutable();
      const dispatcher = join(root, "runtime-dispatch");
      const nodeShim = join(root, "node");
      await writeFile(
        dispatcher,
        `#!/bin/sh
case "\${0##*/}" in
  node) ;;
  *) exit 97 ;;
esac
[ "$HOME" = ${shellSingleQuote(callerHome)} ] || exit 98
exec ${shellSingleQuote(actualNode)} "$@"
`,
      );
      await chmod(dispatcher, 0o755);
      await symlink(dispatcher, nodeShim);

      const { repoRoot, candidate } = await localBundle();
      await smokeGlobalPiRpc(candidate, {
        repoRoot,
        timeoutMs: 20_000,
        nodeExecutable: nodeShim,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects a signal exit after a complete RPC response", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-signal-exit-"));
    try {
      const binaryPath = join(root, "fake-pi.mjs");
      await writeFile(
        binaryPath,
        `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const probePath = process.argv.at(-1);
const source = readFileSync(probePath, "utf8");
const command = source.match(/pi-compat-[0-9a-f-]+/)?.[0];
const marker = source.match(/PI_COMPAT_OK:[0-9a-f-]+/)?.[0];
if (command === undefined || marker === undefined) process.exit(2);

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline === -1) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line === "") continue;
    const request = JSON.parse(line);
    if (request.id === "commands") {
      send({
        type: "response",
        id: "commands",
        success: true,
        data: { commands: [{ name: command }] },
      });
    } else if (request.id === "probe") {
      send({
        type: "extension_ui_request",
        method: "notify",
        message: marker,
      });
      process.stdout.write(
        JSON.stringify({ type: "response", id: "probe", success: true }) +
          "\\n",
        () => process.kill(process.pid, "SIGTERM"),
      );
    }
  }
});
`,
      );
      await chmod(binaryPath, 0o755);
      const binaryRealPath = await realpath(binaryPath);
      const candidate = installation("0.84.4");
      await expect(
        smokeGlobalPiRpc(
          {
            ...candidate,
            binaryPath,
            binaryRealPath,
            packageRoot: root,
          },
          { repoRoot: join(import.meta.dir, "../.."), timeoutMs: 10_000 },
        ),
      ).rejects.toThrow("signal=SIGTERM");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("global pi installation discovery", () => {
  test("tracks runtime cohort changes across legacy and current Pi releases", () => {
    expect(piCohortPackagesForVersion("0.83.0")).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      "typebox",
    ]);
    expect(piCohortPackagesForVersion("0.84.0")).toEqual([
      ...PI_LEGACY_BASELINE_PACKAGES,
    ]);
    expect(piCohortPackagesForVersion("0.85.0")).toEqual([
      ...PI_LEGACY_BASELINE_PACKAGES,
      "@earendil-works/chord",
    ]);
    expect(piCohortPackagesForVersion("0.86.0")).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-telemetry",
      "@earendil-works/pi-tui",
      "typebox",
      "@earendil-works/chord",
    ]);
    expect(() => piCohortPackagesForVersion("latest")).toThrow(
      "invalid version",
    );
  });

  test.each(["0.83.0", "0.84.1", "1.0.4", "1.6.0"])(
    "uses the non-project pi %s on PATH when sandbox cache isolation breaks Bun global discovery",
    async (packageVersion) => {
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
        const chord = "@earendil-works/chord";
        const schema = "@earendil-works/pi-schema";
        const packageNames = [...piCohortPackagesForVersion(packageVersion)];
        const modern = packageVersion === "1.6.0";
        if (packageVersion === "1.0.4" || modern) packageNames.push(chord);
        if (modern)
          packageNames.push(
            schema,
            "@earendil-works/pi-client",
            "@earendil-works/pi-protocol",
          );
        const otherVersions: Record<string, string> = {
          typebox: "1.3.27",
          [chord]: "1.0.4",
        };
        if (modern) {
          otherVersions["@earendil-works/pi-client"] = "0.84.4";
          otherVersions["@earendil-works/pi-protocol"] = "0.84.4";
        }
        let codingAgentRoot = "";
        for (const name of packageNames) {
          const packageRoot = join(globalModules, ...name.split("/"));
          const version = otherVersions[name] ?? packageVersion;
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
            if (packageVersion === "1.0.4") {
              manifest.dependencies = { [chord]: "^1.0.4" };
            }
          }
          if (
            modern &&
            (name === "@earendil-works/pi-ai" ||
              name === "@earendil-works/pi-agent-core")
          ) {
            manifest.dependencies = { [schema]: "1.6.0" };
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
        const discover = () =>
          discoverPiInstallation({
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
        const discovered = await discover();

        expect(discovered.binaryPath).toBe(join(globalBin, "pi"));
        expect(discovered.packageVersion).toBe(packageVersion);
        if (packageVersion === "1.0.4") {
          expect(discovered.corePackages[chord]?.version).toBe("1.0.4");
        } else {
          expect(discovered.corePackages[chord]).toBeUndefined();
        }
        if (modern) {
          expect(discovered.corePackages[schema]?.version).toBe("1.6.0");
        } else {
          expect(discovered.corePackages[schema]).toBeUndefined();
        }
        expect(calls).toEqual([[join(globalBin, "pi"), "--version"]]);

        if (modern) {
          expect(
            discovered.corePackages["@earendil-works/pi-client"],
          ).toBeUndefined();
          expect(
            discovered.corePackages["@earendil-works/pi-protocol"],
          ).toBeUndefined();
          const schemaRoot = join(globalModules, schema);
          const manifestPath = join(schemaRoot, "package.json");
          await writeFile(
            manifestPath,
            JSON.stringify({ name: schema, version: "1.6.0-preview" }),
          );
          await expect(discover()).rejects.toThrow(
            "requires @earendil-works/pi-schema@1.6.0",
          );

          await writeFile(
            manifestPath,
            JSON.stringify({ name: schema, version: "1.6.0" }),
          );
          const redirected = join(localModules, "redirected-schema");
          await rename(schemaRoot, redirected);
          await expect(discover()).rejects.toThrow(/pi-schema/);
          await symlink(redirected, schemaRoot, "dir");
          await expect(discover()).rejects.toThrow(
            "global package root mismatch: expected @earendil-works/pi-schema",
          );
          expect(calls).toHaveLength(1);
        }

        const aliasBin = join(root, "alias-bin");
        await mkdir(aliasBin);
        await symlink(
          join(codingAgentRoot, "dist/cli.js"),
          join(aliasBin, "pi"),
        );
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
    },
  );
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
    const parentFile = join(root, "parent.pid");
    const childFile = join(root, "child.pid");
    const readyFile = join(root, "ready.json");
    let parentPid: number | undefined;
    let childPid: number | undefined;
    const cleanup = async () => {
      const publishedParent = Number(
        await readFile(parentFile, "utf8").catch(() => ""),
      );
      const publishedChild = Number(
        await readFile(childFile, "utf8").catch(() => ""),
      );
      for (const pid of [parentPid, publishedParent]) {
        if (
          pid === undefined ||
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          pid === process.pid
        )
          continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      for (const pid of [
        childPid,
        publishedChild,
        parentPid,
        publishedParent,
      ]) {
        if (
          pid === undefined ||
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          pid === process.pid
        )
          continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    };
    const childSource = `
const { writeFileSync, renameSync } = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), 15000);
writeFileSync(${JSON.stringify(`${readyFile}.tmp`)}, JSON.stringify({ pid: process.pid, parent: process.ppid, termReady: true }));
renameSync(${JSON.stringify(`${readyFile}.tmp`)}, ${JSON.stringify(readyFile)});
`;
    const parentSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(parentFile)}, String(process.pid));
process.on("SIGTERM", () => process.exit(0));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });
child.on("error", () => process.exit(2));
if (child.pid === undefined) process.exit(3);
writeFileSync(${JSON.stringify(childFile)}, String(child.pid));
setTimeout(() => { child.kill("SIGKILL"); process.exit(0); }, 18000);
`;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      void cleanup();
    }, 12_000);
    let returned = false;
    const pending = runCommand([process.execPath, "-e", parentSource], {
      timeoutMs: 5_000,
    }).then(
      (result) => {
        returned = true;
        return { result };
      },
      (error: unknown) => {
        returned = true;
        return { error };
      },
    );
    try {
      const readinessDeadline = Date.now() + 3_000;
      let readyText: string | undefined;
      while (Date.now() < readinessDeadline) {
        expect(returned).toBe(false);
        parentPid =
          Number(await readFile(parentFile, "utf8").catch(() => "")) ||
          undefined;
        childPid =
          Number(await readFile(childFile, "utf8").catch(() => "")) ||
          undefined;
        readyText = await readFile(readyFile, "utf8").catch(() => undefined);
        if (
          readyText !== undefined &&
          parentPid !== undefined &&
          childPid !== undefined
        )
          break;
        await Bun.sleep(20);
      }
      if (readyText === undefined)
        throw new Error("process tree did not become ready before deadline");
      if (parentPid === undefined || childPid === undefined)
        throw new Error("process tree did not publish both PIDs");
      expect(Date.now()).toBeLessThan(readinessDeadline);
      const readyParent = parentPid;
      const readyChild = childPid;
      expect(Number.isSafeInteger(parentPid)).toBe(true);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(parentPid).toBeGreaterThan(1);
      expect(childPid).toBeGreaterThan(1);
      expect(parentPid).not.toBe(childPid);
      expect(parentPid).not.toBe(process.pid);
      expect(childPid).not.toBe(process.pid);
      expect(JSON.parse(readyText)).toEqual({
        pid: childPid,
        parent: parentPid,
        termReady: true,
      });
      expect(() => process.kill(readyParent, 0)).not.toThrow();
      expect(() => process.kill(readyChild, 0)).not.toThrow();
      const relationship = execFileSync(
        "ps",
        ["-p", String(childPid), "-o", "ppid=", "-o", "pgid="],
        {
          encoding: "utf8",
          timeout: 1_000,
        },
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(relationship).toEqual([parentPid, parentPid]);
      expect(returned).toBe(false);
      const outcome = await pending;
      if ("error" in outcome) throw outcome.error;
      expect(watchdogFired).toBe(false);
      expect(outcome.result.timedOut).toBe(true);
      expect(() => process.kill(readyParent, 0)).toThrow();
      expect(() => process.kill(readyChild, 0)).toThrow();
    } finally {
      try {
        await cleanup();
        await pending;
      } finally {
        clearTimeout(watchdog);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 20_000);
});

describe("global declaration resolution guard", () => {
  test("rejects repository-local pi declarations", () => {
    expect(() =>
      assertNoLocalPiResolution(
        [join("/repo", "node_modules/@earendil-works/pi-tui/dist/index.d.ts")],
        "/repo/node_modules",
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
        "/repo/node_modules",
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

  test("rejects chord declarations outside captured package roots", () => {
    expect(() =>
      assertNoLocalPiResolution(
        ["/other/node_modules/@earendil-works/chord/dist/index.d.ts"],
        "/repo/node_modules",
        installation("1.0.4"),
      ),
    ).toThrow("escaped captured package roots");
  });

  test("admits pi-schema declarations only from its own captured root", () => {
    const candidate = installation("1.6.0");
    const schema = "@earendil-works/pi-schema";
    const schemaRoot = join("/global/node_modules", schema);
    const typeFile = join(schemaRoot, "dist/typebox-static.d.ts");
    expect(() =>
      assertNoLocalPiResolution([typeFile], "/repo/node_modules", candidate),
    ).toThrow("escaped captured package roots");
    candidate.corePackages[schema] = {
      root: schemaRoot,
      version: "1.6.0",
      manifest: {},
    };
    expect(() =>
      assertNoLocalPiResolution([typeFile], "/repo/node_modules", candidate),
    ).not.toThrow();
    expect(() =>
      assertNoLocalPiResolution(
        [
          join(
            candidate.packageRoot,
            "node_modules",
            schema,
            "dist/index.d.ts",
          ),
        ],
        "/repo/node_modules",
        candidate,
      ),
    ).toThrow("escaped captured package roots");
    expect(() =>
      assertNoLocalPiResolution(
        [join("/repo/node_modules", schema, "dist/index.d.ts")],
        "/repo/node_modules",
        candidate,
      ),
    ).toThrow("repository-local");
  });

  test("rejects a schema distribution aliased to an unrelated local module", async () => {
    await withSchemaFixture(
      async ({ repoRoot, localModules, schemaRoot, candidate }) => {
        const dist = join(schemaRoot, "dist");
        const alias = join(localModules, "schema-copy");
        await rename(dist, alias);
        await symlink(alias, dist, "dir");
        const listedFiles: string[] = [];
        await expect(
          compileExtensionsAgainstGlobalPi(candidate, {
            repoRoot,
            run: async (argv, options) => {
              const result = await runCommand(argv, options);
              expect(result.exitCode).toBe(0);
              listedFiles.push(...result.stdout.split(/\r?\n/));
              return result;
            },
          }),
        ).rejects.toThrow("escaped captured package roots");
        expect(listedFiles).toContain(join(alias, "index.d.ts"));
      },
    );
  });

  test("rejects a missing declaration reached through the public exports", async () => {
    await withSchemaFixture(
      async ({ repoRoot, localModules, schemaRoot, candidate }) => {
        await writeFile(
          join(localModules, "bun-types/index.d.ts"),
          "type Unused = MissingThirdPartyType;",
        );
        const compile = () =>
          compileExtensionsAgainstGlobalPi(candidate, { repoRoot });
        await compile();
        await rm(join(schemaRoot, "dist/part.d.ts"));
        await expect(compile()).rejects.toThrow(
          /TS2307: Cannot find module '\.\/part\.js'/,
        );
        await writeFile(join(schemaRoot, "dist/part.js"), "export {};");
        await expect(compile()).rejects.toThrow(
          /TS7016: Could not find a declaration file for module '\.\/part\.js'/,
        );
      },
    );
  });

  test("allows declaration links only within the same captured package", async () => {
    await withSchemaFixture(async ({ repoRoot, schemaRoot, candidate }) => {
      const part = join(schemaRoot, "dist/part.d.ts");
      const ownFile = join(schemaRoot, "internal.d.ts");
      await rename(part, ownFile);
      await symlink(ownFile, part);
      const compile = () =>
        compileExtensionsAgainstGlobalPi(candidate, { repoRoot });
      await compile();

      const tui = "@earendil-works/pi-tui";
      const tuiRoot = join(dirname(dirname(schemaRoot)), tui);
      candidate.corePackages[tui] = {
        root: tuiRoot,
        version: "1.6.0",
        manifest: {},
      };
      await mkdir(tuiRoot);
      const foreignFile = join(tuiRoot, "internal.d.ts");
      await rename(ownFile, foreignFile);
      await rm(part);
      await symlink(foreignFile, part);
      await expect(compile()).rejects.toThrow("escaped captured package roots");

      const outsideFile = join(repoRoot, "outside.d.ts");
      await rename(foreignFile, outsideFile);
      await rm(part);
      await symlink(outsideFile, part);
      await expect(compile()).rejects.toThrow("escaped captured package roots");
    });
  });

  test("rejects repository-local Pi declarations in a symlinked dependency directory", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "pi-local-types-"),
    );
    try {
      const repo = join(root, "repo");
      const repoRoot = join(root, "repo-link");
      const dependencies = join(root, "dependencies");
      const modules = join(root, "global/node_modules");
      const candidate = installation("1.6.0");
      candidate.packageRoot = join(modules, candidate.packageName);
      const schema = "@earendil-works/pi-schema";
      const schemaRoot = join(modules, schema);
      candidate.corePackages = {
        [schema]: { root: schemaRoot, version: "1.6.0", manifest: {} },
      };
      const localSchema = join(dependencies, schema, "index.d.ts");
      const globalSchema = join(schemaRoot, "index.d.ts");
      for (const directory of [
        ...["pi-harness", "hearth-tools", "codex-web"].map((name) =>
          join(repo, "pi/extensions", name),
        ),
        dirname(localSchema),
        schemaRoot,
      ]) {
        await mkdir(directory, { recursive: true });
      }
      await symlink(repo, repoRoot, "dir");
      await symlink(dependencies, join(repo, "node_modules"), "dir");
      await writeFile(localSchema, "export {}");
      await writeFile(globalSchema, "export {}");

      const compile = (declaration: string) =>
        compileExtensionsAgainstGlobalPi(candidate, {
          repoRoot,
          run: async (argv) => ({
            argv,
            stdout: `${declaration}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
            truncated: false,
          }),
        });
      await expect(compile(localSchema)).rejects.toThrow("repository-local");
      await compile(globalSchema);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
