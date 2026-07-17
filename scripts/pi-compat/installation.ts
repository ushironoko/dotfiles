import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { PI_BASELINE_PACKAGES } from "./baseline";
import {
  runCommand,
  type CommandRunner,
  type RunCommandOptions,
} from "./process";

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  main?: string;
  types?: string;
  dependencies?: Record<string, string>;
}

export interface PiCorePackage {
  root: string;
  version: string;
  manifest: PackageManifest;
}

export interface PiInstallation {
  bunExecutable: string;
  globalBin: string;
  binaryPath: string;
  binaryRealPath: string;
  packageRoot: string;
  packageName: string;
  packageVersion: string;
  corePackages: Record<string, PiCorePackage>;
}

export interface DiscoverInstallationOptions {
  bunExecutable?: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  commandOptions?: RunCommandOptions;
}

const readManifest = async (root: string): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageManifest;

const findPackageRoot = async (
  entry: string,
  expectedName: string,
): Promise<string> => {
  let current = dirname(entry);
  while (true) {
    try {
      const manifest = await readManifest(current);
      if (manifest.name === expectedName) return realpath(current);
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not locate package root for ${expectedName}`);
};

const findNodeModulesRoot = (packageRoot: string): string => {
  let current = packageRoot;
  while (true) {
    if (basename(current) === "node_modules") return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `global pi package is not inside node_modules: ${packageRoot}`,
  );
};

const parseVersion = (value: string): [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareVersion = (
  left: [number, number, number],
  right: [number, number, number],
): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Minimal fail-closed support for the exact/caret ranges in pi manifests. */
export const satisfiesManifestRange = (
  version: string,
  range: string,
): boolean => {
  const actual = parseVersion(version);
  const caret = range.startsWith("^");
  const expected = parseVersion(caret ? range.slice(1) : range);
  if (actual === undefined || expected === undefined) return false;
  if (!caret) return compareVersion(actual, expected) === 0;
  if (compareVersion(actual, expected) < 0) return false;
  if (expected[0] > 0) return actual[0] === expected[0];
  if (expected[1] > 0) {
    return actual[0] === 0 && actual[1] === expected[1];
  }
  return actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2];
};

const assertSuccess = (
  label: string,
  result: Awaited<ReturnType<CommandRunner>>,
) => {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `${label} failed${result.timedOut ? " (timed out)" : ""}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
};

export const discoverPiInstallation = async (
  options: DiscoverInstallationOptions = {},
): Promise<PiInstallation> => {
  const bunExecutable = resolve(options.bunExecutable ?? process.execPath);
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const globalBin = assertSuccess(
    "bun global bin discovery",
    await run([bunExecutable, "pm", "bin", "--global"], options.commandOptions),
  );
  if (!isAbsolute(globalBin)) {
    throw new Error("Bun global bin directory is not absolute");
  }

  const executable = platform === "win32" ? "pi.exe" : "pi";
  const binaryPath = join(globalBin, executable);
  const binaryRealPath = await realpath(binaryPath);
  const packageRoot = await findPackageRoot(
    binaryRealPath,
    "@earendil-works/pi-coding-agent",
  );
  const codingManifest = await readManifest(packageRoot);
  const packageName = codingManifest.name;
  const packageVersion = codingManifest.version;
  if (packageName === undefined || packageVersion === undefined) {
    throw new Error("global pi package manifest lacks name/version");
  }
  const binTarget = codingManifest.bin?.pi;
  if (binTarget === undefined)
    throw new Error("global pi manifest lacks bin.pi");
  if ((await realpath(join(packageRoot, binTarget))) !== binaryRealPath) {
    throw new Error(
      "global pi binary does not belong to the discovered package",
    );
  }
  const binaryVersion = assertSuccess(
    "global pi version",
    await run([binaryPath, "--version"], options.commandOptions),
  );
  if (binaryVersion !== packageVersion) {
    throw new Error(
      `global pi binary ${binaryVersion} != package ${packageVersion}`,
    );
  }

  const globalModules = findNodeModulesRoot(packageRoot);
  const corePackages: Record<string, PiCorePackage> = {};
  for (const name of PI_BASELINE_PACKAGES) {
    const root =
      name === packageName
        ? packageRoot
        : await realpath(join(globalModules, ...name.split("/")));
    const manifest = await readManifest(root);
    if (manifest.name !== name) {
      throw new Error(`global package root mismatch: expected ${name}`);
    }
    if (manifest.version === undefined) {
      throw new Error(`${name} manifest lacks a version`);
    }
    corePackages[name] = {
      root,
      version: manifest.version,
      manifest,
    };
  }

  const cohortNames = new Set<string>(PI_BASELINE_PACKAGES);
  for (const [owner, pkg] of Object.entries(corePackages)) {
    for (const [dependency, range] of Object.entries(
      pkg.manifest.dependencies ?? {},
    )) {
      if (!cohortNames.has(dependency)) continue;
      const installed = corePackages[dependency];
      if (
        installed === undefined ||
        !satisfiesManifestRange(installed.version, range)
      ) {
        throw new Error(
          `${owner} requires ${dependency}@${range}, installed ${installed?.version ?? "missing"}`,
        );
      }
    }
  }

  return {
    bunExecutable,
    globalBin: await realpath(globalBin),
    binaryPath,
    binaryRealPath,
    packageRoot,
    packageName,
    packageVersion,
    corePackages,
  };
};
