import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoLocalPiResolution } from "../../scripts/pi-compat/compile";
import { checkPiCompatibility } from "../../scripts/pi-compat/index";
import {
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

describe("strict pi RPC JSONL framing", () => {
  test("handles fragmented UTF-8 and keeps Unicode line separators inside JSON", () => {
    const decoder = new StrictJsonlDecoder();
    const bytes = Buffer.from('{"text":"a b😀"}\n{"ok":true}\r\n');
    const split = bytes.indexOf(Buffer.from("😀")) + 1;
    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(decoder.push(bytes.subarray(split))).toEqual([
      { text: "a b😀" },
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
      const pid = Number((await readFile(pidFile, "utf8")).trim());
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

  test("accepts files from the captured global package roots", () => {
    expect(() =>
      assertNoLocalPiResolution(
        ["/global/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
        "/repo",
        installation(),
      ),
    ).not.toThrow();
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
