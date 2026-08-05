import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PiCorePackage,
  PiInstallation,
} from "../../scripts/pi-compat/installation";
import {
  applyPiPatches,
  type PiPatchSpec,
} from "../../scripts/pi-compat/patches";
import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "../../scripts/pi-compat/process";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const commandFailure = (argv: string[], message: string): CommandResult => ({
  argv,
  exitCode: 1,
  stdout: "",
  stderr: message,
  timedOut: false,
  truncated: false,
});

const createPackage = async (
  root: string,
  packageName: string,
  version: string,
  value = "old\n",
): Promise<PiCorePackage> => {
  const packageRoot = join(root, "packages", packageName.replaceAll("/", "-"));
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "value.js"), value);
  return {
    root: packageRoot,
    version,
    manifest: { name: packageName, version },
  };
};

const writePatch = async (
  repoRoot: string,
  name: string,
  before = "old",
  after = "new",
): Promise<string> => {
  const relativePath = join("patches", `${name}.patch`);
  await mkdir(join(repoRoot, "patches"), { recursive: true });
  await writeFile(
    join(repoRoot, relativePath),
    `diff --git a/dist/value.js b/dist/value.js\n--- a/dist/value.js\n+++ b/dist/value.js\n@@ -1 +1 @@\n-${before}\n+${after}\n`,
  );
  return relativePath;
};

const installation = (
  corePackages: Record<string, PiCorePackage>,
): PiInstallation => ({
  bunExecutable: "/tools/bun",
  globalBin: "/global/bin",
  binaryPath: "/global/bin/pi",
  binaryRealPath: "/global/node_modules/pi/dist/cli.js",
  packageRoot: "/global/node_modules/pi",
  packageName: "@earendil-works/pi-coding-agent",
  packageVersion: "0.83.0",
  corePackages,
});

const setup = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-patches-test-"));
  roots.push(root);
  return root;
};

describe("global Pi sticky patch application", () => {
  test("applies an exact-version patch and is idempotent", async () => {
    const root = await setup();
    const packageName = "@earendil-works/pi-tui";
    const pkg = await createPackage(root, packageName, "0.83.0");
    const file = await writePatch(root, "tui");
    const specs: PiPatchSpec[] = [
      { packageName, version: "0.83.0", file },
      {
        packageName,
        version: "0.84.0",
        file: "patches/future-generation.patch",
      },
    ];
    const discovered = installation({ [packageName]: pkg });

    await expect(
      applyPiPatches(discovered, {
        repoRoot: root,
        specs,
        checkOnly: true,
      }),
    ).resolves.toEqual([
      { packageName, version: "0.83.0", status: "pending" },
    ]);
    expect(await readFile(join(pkg.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );

    await expect(
      applyPiPatches(discovered, { repoRoot: root, specs }),
    ).resolves.toEqual([{ packageName, version: "0.83.0", status: "applied" }]);
    expect(await readFile(join(pkg.root, "dist", "value.js"), "utf8")).toBe(
      "new\n",
    );

    await expect(
      applyPiPatches(discovered, {
        repoRoot: root,
        specs,
        checkOnly: true,
      }),
    ).resolves.toEqual([
      { packageName, version: "0.83.0", status: "already-applied" },
    ]);
    await expect(
      applyPiPatches(discovered, { repoRoot: root, specs }),
    ).resolves.toEqual([
      { packageName, version: "0.83.0", status: "already-applied" },
    ]);
  });

  test("reverses only newly applied patches when post-verification fails", async () => {
    const root = await setup();
    const alreadyName = "@earendil-works/pi-tui";
    const pendingName = "@earendil-works/pi-coding-agent";
    const already = await createPackage(root, alreadyName, "0.83.0", "new\n");
    const pending = await createPackage(root, pendingName, "0.83.0");
    const alreadyPatch = await writePatch(root, "tui");
    const pendingPatch = await writePatch(root, "coding-agent");
    const specs: PiPatchSpec[] = [
      { packageName: alreadyName, version: "0.83.0", file: alreadyPatch },
      { packageName: pendingName, version: "0.83.0", file: pendingPatch },
    ];

    await expect(
      applyPiPatches(
        installation({ [alreadyName]: already, [pendingName]: pending }),
        {
          repoRoot: root,
          specs,
          verify: async () => {
            throw new Error("post-compatibility failed");
          },
        },
      ),
    ).rejects.toThrow("post-compatibility failed");

    expect(
      await readFile(join(already.root, "dist", "value.js"), "utf8"),
    ).toBe("new\n");
    expect(
      await readFile(join(pending.root, "dist", "value.js"), "utf8"),
    ).toBe("old\n");
  });

  test("detaches package files before patching so Bun cache hardlinks stay clean", async () => {
    const root = await setup();
    const packageName = "@earendil-works/pi-tui";
    const pkg = await createPackage(root, packageName, "0.83.0");
    const target = join(pkg.root, "dist", "value.js");
    const cacheFile = join(root, "bun-cache-value.js");
    await writeFile(cacheFile, "old\n");
    await rm(target);
    await link(cacheFile, target);
    const targetBefore = await stat(target);
    const cacheBefore = await stat(cacheFile);
    expect(targetBefore.ino).toBe(cacheBefore.ino);
    const file = await writePatch(root, "tui");
    const specs: PiPatchSpec[] = [{ packageName, version: "0.83.0", file }];

    await applyPiPatches(installation({ [packageName]: pkg }), {
      repoRoot: root,
      specs,
    });

    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readFile(cacheFile, "utf8")).toBe("old\n");
    const targetAfter = await stat(target);
    const cacheAfter = await stat(cacheFile);
    expect(targetAfter.ino).not.toBe(cacheAfter.ino);
  });

  test("rejects unsupported package versions before mutation", async () => {
    const root = await setup();
    const packageName = "@earendil-works/pi-tui";
    const pkg = await createPackage(root, packageName, "0.84.0");
    const file = await writePatch(root, "tui");
    const specs: PiPatchSpec[] = [{ packageName, version: "0.83.0", file }];

    await expect(
      applyPiPatches(installation({ [packageName]: pkg }), {
        repoRoot: root,
        specs,
      }),
    ).rejects.toThrow("no @earendil-works/pi-tui sticky patch for 0.84.0");
    expect(await readFile(join(pkg.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );
  });

  test("can leave an unsupported preflight generation untouched", async () => {
    const root = await setup();
    const packageName = "@earendil-works/pi-tui";
    const pkg = await createPackage(root, packageName, "0.82.0");
    const file = await writePatch(root, "tui");
    const specs: PiPatchSpec[] = [{ packageName, version: "0.83.0", file }];

    await expect(
      applyPiPatches(installation({ [packageName]: pkg }), {
        repoRoot: root,
        specs,
        allowUnsupported: true,
      }),
    ).resolves.toEqual([]);
    expect(await readFile(join(pkg.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );
  });

  test("validates the whole patch cohort before changing any package", async () => {
    const root = await setup();
    const firstName = "@earendil-works/pi-tui";
    const secondName = "@earendil-works/pi-coding-agent";
    const first = await createPackage(root, firstName, "0.83.0");
    const second = await createPackage(root, secondName, "0.83.0", "drifted\n");
    const firstPatch = await writePatch(root, "tui");
    const secondPatch = await writePatch(root, "coding-agent");
    const specs: PiPatchSpec[] = [
      { packageName: firstName, version: "0.83.0", file: firstPatch },
      { packageName: secondName, version: "0.83.0", file: secondPatch },
    ];

    await expect(
      applyPiPatches(
        installation({ [firstName]: first, [secondName]: second }),
        { repoRoot: root, specs },
      ),
    ).rejects.toThrow("does not match either side");
    expect(await readFile(join(first.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );
  });

  test("rolls back patches from the current invocation if a later apply fails", async () => {
    const root = await setup();
    const firstName = "@earendil-works/pi-tui";
    const secondName = "@earendil-works/pi-coding-agent";
    const first = await createPackage(root, firstName, "0.83.0");
    const second = await createPackage(root, secondName, "0.83.0");
    const firstPatch = await writePatch(root, "tui", "old", "first");
    const secondPatch = await writePatch(root, "coding-agent", "old", "second");
    const specs: PiPatchSpec[] = [
      { packageName: firstName, version: "0.83.0", file: firstPatch },
      { packageName: secondName, version: "0.83.0", file: secondPatch },
    ];
    const run: CommandRunner = async (argv, options) => {
      const applyingSecond =
        !argv.includes("--check") &&
        !argv.includes("--reverse") &&
        argv.includes(join(root, secondPatch));
      return applyingSecond
        ? commandFailure(argv, "simulated write failure")
        : runCommand(argv, options);
    };

    await expect(
      applyPiPatches(
        installation({ [firstName]: first, [secondName]: second }),
        { repoRoot: root, specs, run },
      ),
    ).rejects.toThrow("simulated write failure");
    expect(await readFile(join(first.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );
    expect(await readFile(join(second.root, "dist", "value.js"), "utf8")).toBe(
      "old\n",
    );
  });
});
