import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PI_KNOWN_PACKAGES } from "./baseline";
import type { PiInstallation } from "./installation";
import { runCommand, type CommandRunner } from "./process";

export interface CompileGlobalOptions {
  repoRoot?: string;
  run?: CommandRunner;
  keepTemp?: boolean;
}

export const PI_HARNESS_RUNTIME_PACKAGES = [
  "@anthropic-ai/sandbox-runtime",
  "@pondwader/socks5-server",
  "commander",
  "lodash-es",
  "shell-quote",
  "zod",
] as const;

const piPackageRoots = (file: string): string[] =>
  Array.from(
    file.matchAll(
      /[\\/]node_modules[\\/](?:@earendil-works[\\/][^\\/]+|typebox)(?=[\\/]|$)/g,
    ),
    (match) => file.slice(0, match.index + match[0].length),
  );

const knownPiPackages = new Set<string>(PI_KNOWN_PACKAGES);

const isInside = (root: string, path: string): boolean =>
  path.startsWith(`${root}${sep}`);

const isPackagePath = (root: string, path: string): boolean =>
  isInside(root, path) &&
  !path
    .slice(root.length + 1)
    .split(sep)
    .includes("node_modules");

const escapedPackageRoots = (file: string): Error =>
  new Error(`global contract escaped captured package roots: ${file}`);

const assertCapturedPackageLinks = async (root: string): Promise<void> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const alias = join(entry.parentPath, entry.name);
    const target = await realpath(alias).catch(() => {
      throw escapedPackageRoots(alias);
    });
    if (!isPackagePath(root, alias) || !isPackagePath(root, target)) {
      throw escapedPackageRoots(alias);
    }
  }
};

const locatedDiagnostic = /^(.+)\(\d+,\d+\): error TS\d+:/;

export const assertNoLocalPiResolution = (
  files: string[],
  localModules: string,
  installation: PiInstallation,
): void => {
  const localPiRoots = ["@earendil-works", "typebox"].map((name) =>
    join(localModules, name),
  );
  const globalRoots = new Set(
    Object.entries(installation.corePackages)
      .filter(
        ([name, { root }]) =>
          knownPiPackages.has(name) &&
          root === join(dirname(dirname(installation.packageRoot)), name),
      )
      .map(([, { root }]) => resolve(root)),
  );
  for (const file of files) {
    const absolute = resolve(file);
    const packageRoots = piPackageRoots(absolute);
    if (
      localPiRoots.some(
        (root) => absolute === root || isInside(root, absolute),
      ) ||
      packageRoots.some((root) => isInside(localModules, root))
    ) {
      throw new Error(
        `global contract resolved repository-local pi types: ${file}`,
      );
    }
    for (const root of packageRoots) {
      if (!globalRoots.has(root)) {
        throw escapedPackageRoots(file);
      }
    }
  }
};

export const compileExtensionsAgainstGlobalPi = async (
  installation: PiInstallation,
  options: CompileGlobalOptions = {},
): Promise<void> => {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, "../.."));
  const run = options.run ?? runCommand;
  const tempRoot = await mkdtemp(
    join(await realpath(tmpdir()), "pi-compat-types-"),
  );
  try {
    const sourceRoot = join(tempRoot, "extensions");
    const globalModules = dirname(dirname(installation.packageRoot));
    const localModules = join(repoRoot, "node_modules");
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
    await cp(
      join(repoRoot, "pi/extensions/hearth-tools"),
      join(sourceRoot, "hearth-tools"),
      { recursive: true },
    );

    // Recreate only pi's captured package closure under a temporary
    // node_modules. TypeScript now honors package exports/types normally.
    const tempModules = join(tempRoot, "node_modules");
    const capturedRoots: string[] = [];
    for (const [name, pkg] of Object.entries(installation.corePackages)) {
      if (
        !knownPiPackages.has(name) ||
        pkg.root !== join(globalModules, name) ||
        (await realpath(pkg.root)) !== pkg.root
      ) {
        throw new Error(`invalid captured global Pi package: ${name}`);
      }
      capturedRoots.push(pkg.root);
      const target = join(tempModules, ...name.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true });
      await symlink(pkg.root, target, "dir");
    }
    const localRuntimePackages = [
      "@hearthdev/napi",
      ...PI_HARNESS_RUNTIME_PACKAGES,
    ];
    for (const name of localRuntimePackages) {
      const target = join(tempModules, ...name.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true });
      await symlink(join(repoRoot, "node_modules", name), target, "dir");
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
            skipLibCheck: false,
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
      [
        compiler,
        "--project",
        tsconfigPath,
        "--noEmit",
        "--pretty",
        "false",
        "--listFiles",
      ],
      { cwd: tempRoot, timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 },
    );
    const files: string[] = [];
    const diagnostics: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (isAbsolute(trimmed) && !locatedDiagnostic.test(trimmed))
        files.push(trimmed);
      else diagnostics.push(line);
    }
    assertNoLocalPiResolution(files, localModules, installation);
    const [canonicalSource, canonicalGlobal, canonicalLocal] =
      await Promise.all([
        realpath(sourceRoot),
        realpath(globalModules),
        realpath(localModules),
      ]);
    const allowedRoots = [canonicalSource, canonicalGlobal, canonicalLocal];
    await Promise.all(capturedRoots.map(assertCapturedPackageLinks));
    const resolutions = await Promise.all(
      files.map(async (file) => ({ file, canonical: await realpath(file) })),
    );
    assertNoLocalPiResolution(
      resolutions.map(({ canonical }) => canonical),
      canonicalLocal,
      installation,
    );
    const externalDeclarations = new Set<string>();
    for (const { file, canonical } of resolutions) {
      if (
        !allowedRoots.some((root) => isInside(root, canonical)) ||
        (canonical !== resolve(file) &&
          piPackageRoots(file).some((root) => !isPackagePath(root, canonical)))
      ) {
        throw escapedPackageRoots(file);
      }
      if (
        /\.d\.[cm]?ts$/i.test(canonical) &&
        !isInside(canonicalSource, canonical) &&
        !capturedRoots.some((root) => isPackagePath(root, canonical))
      ) {
        externalDeclarations.add(resolve(file));
        externalDeclarations.add(canonical);
      }
    }
    const diagnosticText = diagnostics.join("\n").trim();
    const contractDiagnostics = diagnosticText
      .split(/\r?\n\r?\n/)
      .filter((diagnostic) => {
        const file = locatedDiagnostic.exec(diagnostic)?.[1];
        return !file || !externalDeclarations.has(resolve(tempRoot, file));
      })
      .join("\n\n");
    const ignoredDependencyErrors =
      result.exitCode === 2 && diagnosticText !== "";
    if (
      result.timedOut ||
      result.truncated ||
      (result.exitCode !== 0 && !ignoredDependencyErrors) ||
      contractDiagnostics !== "" ||
      result.stderr.trim() !== ""
    ) {
      let reason = "";
      if (result.timedOut) reason = " (timed out)";
      else if (result.truncated) reason = " (output truncated)";
      throw new Error(
        `global pi declaration contract failed${reason}:\n${contractDiagnostics}${result.stderr}`,
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
