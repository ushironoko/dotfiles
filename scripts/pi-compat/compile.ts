import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PI_BASELINE_PACKAGES } from "./baseline";
import type { PiInstallation } from "./installation";
import { runCommand, type CommandRunner } from "./process";

export interface CompileGlobalOptions {
  repoRoot?: string;
  run?: CommandRunner;
  keepTemp?: boolean;
}

export const assertNoLocalPiResolution = (
  files: string[],
  repoRoot: string,
  installation: PiInstallation,
): void => {
  const localModules = join(repoRoot, "node_modules");
  const globalRoots = new Set(
    Object.values(installation.corePackages).map(({ root }) => resolve(root)),
  );
  for (const file of files) {
    const absolute = resolve(file);
    if (
      absolute.startsWith(`${localModules}/@earendil-works/`) ||
      absolute.startsWith(`${localModules}/typebox/`)
    ) {
      throw new Error(
        `global contract resolved repository-local pi types: ${file}`,
      );
    }
    if (!absolute.includes("node_modules")) continue;
    if (!/node_modules\/(?:@earendil-works\/pi-|typebox\/)/.test(absolute)) {
      continue;
    }
    const belongsToGlobal = [...globalRoots].some(
      (root) => absolute === root || absolute.startsWith(`${root}/`),
    );
    if (!belongsToGlobal) {
      throw new Error(
        `global contract escaped captured package roots: ${file}`,
      );
    }
  }
};

export const compileExtensionsAgainstGlobalPi = async (
  installation: PiInstallation,
  options: CompileGlobalOptions = {},
): Promise<void> => {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, "../.."));
  const run = options.run ?? runCommand;
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-compat-types-"));
  try {
    const sourceRoot = join(tempRoot, "extensions");
    await cp(
      join(repoRoot, "pi/extensions/pi-harness"),
      join(sourceRoot, "pi-harness"),
      {
        recursive: true,
      },
    );
    await cp(
      join(repoRoot, "pi/extensions/codex-web"),
      join(sourceRoot, "codex-web"),
      {
        recursive: true,
      },
    );

    // Recreate only pi's captured package closure under a temporary
    // node_modules. TypeScript now honors package exports/types normally.
    const tempModules = join(tempRoot, "node_modules");
    for (const name of PI_BASELINE_PACKAGES) {
      const pkg = installation.corePackages[name];
      if (pkg === undefined)
        throw new Error(`global type package missing: ${name}`);
      const target = join(tempModules, ...name.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true });
      await symlink(pkg.root, target, "dir");
    }

    const tsconfigPath = join(tempRoot, "tsconfig.json");
    await writeFile(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            isolatedModules: true,
            resolveJsonModule: true,
            typeRoots: [
              join(repoRoot, "node_modules/@types"),
              join(repoRoot, "node_modules"),
            ],
            types: ["bun-types"],
          },
          include: [join(sourceRoot, "**/*.ts")],
        },
        null,
        2,
      ),
    );

    const compiler = join(repoRoot, "node_modules/.bin/tsgo");
    const result = await run(
      [compiler, "--project", tsconfigPath, "--noEmit", "--listFiles"],
      { cwd: tempRoot, timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 },
    );
    const files = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => isAbsolute(line));
    assertNoLocalPiResolution(files, repoRoot, installation);
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `global pi declaration contract failed${result.timedOut ? " (timed out)" : ""}:\n${result.stdout}${result.stderr}`,
      );
    }
    if (files.length === 0) {
      throw new Error(
        "global pi declaration compiler returned no resolution list",
      );
    }
  } finally {
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
  }
};
