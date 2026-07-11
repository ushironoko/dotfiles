import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupStatusline from "../../pi/extensions/pi-harness/features/statusline/index";
import {
  parseStatuslineCache,
  renderStatusline,
  STATUSLINE_WIDGET_KEY,
} from "../../pi/extensions/pi-harness/features/statusline/render";
import type { DetachedSpawnFunction } from "../../pi/extensions/pi-harness/lib/detached";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const tempDirectories: string[] = [];

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await setupTestDirectory(prefix);
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

const makeConfig = (
  home: string,
  trustedRoots: string[] = [],
): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
  },
  trust: { trustedRoots },
  paths: resolvePaths(home),
});

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
};

const sampleCache = (label = "ts") => ({
  project_root: "/repo",
  language: "ts",
  label,
  updated_at: 123,
  checks: {
    lint: { status: "ok" },
    typecheck: { status: "running" },
    test: { status: "fail" },
  },
});

/** Seed a cache file exactly where the bash runner would write it. */
const seedCache = async (
  cacheDir: string,
  projectRoot: string,
  payload: unknown,
): Promise<void> => {
  const hash = createHash("sha1").update(projectRoot).digest("hex");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(join(cacheDir, `${hash}.json`), JSON.stringify(payload));
};

/** Make a directory look like a ts project so the root detector accepts it. */
const markAsProject = async (root: string): Promise<void> => {
  await fs.writeFile(join(root, "package.json"), "{}");
  await fs.writeFile(join(root, "tsconfig.json"), "{}");
};

describe("renderStatusline", () => {
  test("renders label, one glyph per check slot, and the branch", () => {
    const lines = renderStatusline(sampleCache(), "feat/x");
    expect(lines).toEqual(["ts lint:✓ type:… test:✗ (feat/x)"]);
  });

  test("unknown statuses render as ?", () => {
    const cache = {
      label: "rust",
      checks: { lint: { status: "weird" }, typecheck: {}, test: undefined },
    };
    const lines = renderStatusline(cache, undefined);
    expect(lines).toEqual(["rust lint:? type:? test:?"]);
  });

  test("branch-only rendering works without a cache", () => {
    expect(renderStatusline(undefined, "main")).toEqual(["(main)"]);
  });

  test("nothing to show clears the widget", () => {
    expect(renderStatusline(undefined, undefined)).toBeUndefined();
  });

  test("parseStatuslineCache rejects malformed JSON and non-objects", () => {
    expect(parseStatuslineCache("not json")).toBeUndefined();
    expect(parseStatuslineCache('"string"')).toBeUndefined();
    expect(parseStatuslineCache('{"label":"ts"}')).toEqual({ label: "ts" });
  });
});

describe("pi-harness statusline feature", () => {
  test("agent_settled launches the checks runner detached for a trusted root", async () => {
    const home = await makeTempDirectory("pi-statusline-run");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const captureFile = join(home, "runner-called.txt");
    const runner = join(
      resolvePaths(home).claudeHooksDir,
      "lib/statusline_checks_run.sh",
    );
    await fs.mkdir(dirname(runner), { recursive: true });
    // Temp-then-rename so the poller never observes a half-written capture.
    await fs.writeFile(
      runner,
      [
        "#!/bin/bash",
        `printf '%s\\n' "$1" > "${captureFile}.tmp"`,
        `mv "${captureFile}.tmp" "${captureFile}"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const pi = createFakePi({ cwd: project });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
      getBranch: async () => undefined,
    });

    await pi.emitAgentSettled();
    await waitFor(async () => {
      try {
        await fs.access(captureFile);
        return true;
      } catch {
        return false;
      }
    });
    const captured = (await fs.readFile(captureFile, "utf8")).trim();
    expect(captured).toBe(project);
  });

  test("an untrusted root never launches the runner but still renders", async () => {
    const home = await makeTempDirectory("pi-statusline-untrusted");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const cacheDir = join(home, "cache");
    await seedCache(cacheDir, project, sampleCache());
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };

    const pi = createFakePi({ cwd: project });
    setupStatusline(pi, makeConfig(home, []), {
      cacheDir,
      spawnDetached,
      getBranch: async () => "main",
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
    expect(pi.widgets.get(STATUSLINE_WIDGET_KEY)).toEqual([
      "ts lint:✓ type:… test:✗ (main)",
    ]);
  });

  test("session_start renders the widget from the cache", async () => {
    const home = await makeTempDirectory("pi-statusline-render");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const cacheDir = join(home, "cache");
    await seedCache(cacheDir, project, sampleCache("bun"));
    const spawnDetached: DetachedSpawnFunction = () => {};

    const pi = createFakePi({ cwd: project });
    setupStatusline(pi, makeConfig(home, []), {
      cacheDir,
      spawnDetached,
      getBranch: async () => "feat/pi",
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(pi.widgets.get(STATUSLINE_WIDGET_KEY)).toEqual([
      "bun lint:✓ type:… test:✗ (feat/pi)",
    ]);
  });

  test("outside a detected project the widget falls back to the branch", async () => {
    const home = await makeTempDirectory("pi-statusline-noproject");
    const plainDir = join(home, "plain");
    await fs.mkdir(plainDir, { recursive: true });
    const spawnDetached: DetachedSpawnFunction = () => {};

    const pi = createFakePi({ cwd: plainDir });
    setupStatusline(pi, makeConfig(home, []), {
      cacheDir: join(home, "cache"),
      spawnDetached,
      getBranch: async () => "main",
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(pi.widgets.get(STATUSLINE_WIDGET_KEY)).toEqual(["(main)"]);
  });
});
