import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  PI_CHORD_PACKAGE,
  PI_LEGACY_BASELINE_PACKAGES,
  PI_MODERN_CORE_PACKAGES,
  PI_SCHEMA_PACKAGE,
  type PiBaselinePackage,
} from "./baseline";
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
  environment?: NodeJS.ProcessEnv;
  excludedPackageRoots?: string[];
}

const readManifest = async (root: string): Promise<PackageManifest> => {
  const path = join(root, "package.json");
  const stats = await lstat(path);
  if (!stats.isFile()) {
    throw new Error(`global package manifest is not a file: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
};

const isWithin = (root: string, target: string): boolean => {
  const relation = relative(resolve(root), resolve(target));
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
};

const findPiOnPath = async (
  pathValue: string | undefined,
  executable: string,
  excludedRoots: string[],
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  for (const entry of pathValue?.split(delimiter) ?? []) {
    const candidate = resolve(entry === "" ? "." : entry, executable);
    try {
      await access(
        candidate,
        platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const target = await realpath(candidate);
      if (excludedRoots.some((root) => isWithin(root, target))) continue;
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return undefined;
};

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

const PI_084_ADDED_PACKAGES = new Set<PiBaselinePackage>([
  "@earendil-works/pi-client",
  "@earendil-works/pi-protocol",
  "@earendil-works/pi-telemetry",
]);

/**
 * Pi 0.84 split three new packages out of the coding-agent closure. Keep the
 * legacy cohort discoverable so the safe updater can verify and migrate an
 * installed 0.83 source before requiring the complete 0.84+ cohort.
 */
export const piCohortPackagesForVersion = (
  version: string,
): readonly PiBaselinePackage[] => {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    throw new Error(`global pi package has an invalid version: ${version}`);
  }
  if (compareVersion(parsed, [0, 99, 0]) >= 0) return PI_MODERN_CORE_PACKAGES;
  if (compareVersion(parsed, [0, 86, 0]) >= 0) {
    return [
      ...PI_MODERN_CORE_PACKAGES.filter(
        (name) =>
          name !== "@earendil-works/pi-codemode" &&
          name !== "@earendil-works/pi-mcp",
      ),
      PI_CHORD_PACKAGE,
    ];
  }
  if (compareVersion(parsed, [0, 85, 0]) >= 0) {
    return [...PI_LEGACY_BASELINE_PACKAGES, PI_CHORD_PACKAGE];
  }
  return compareVersion(parsed, [0, 84, 0]) >= 0
    ? PI_LEGACY_BASELINE_PACKAGES
    : PI_LEGACY_BASELINE_PACKAGES.filter(
        (name) => !PI_084_ADDED_PACKAGES.has(name),
      );
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
  if (!caret) return version === range;
  if (version === range.slice(1)) return true;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\^\d+\.\d+\.\d+$/.test(range)) {
    return false;
  }
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
  const environment =
    options.environment ?? options.commandOptions?.env ?? process.env;
  const configuredExcludedRoots = options.excludedPackageRoots ?? [
    resolve(import.meta.dir, "../../node_modules"),
  ];
  const excludedPackageRoots = await Promise.all(
    configuredExcludedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );
  const executable = platform === "win32" ? "pi.exe" : "pi";
  const pathBinary = await findPiOnPath(
    environment.PATH,
    executable,
    excludedPackageRoots,
    platform,
  );
  let binaryPath: string;
  let globalBin: string;
  if (pathBinary !== undefined) {
    binaryPath = pathBinary;
    globalBin = dirname(pathBinary);
  } else {
    globalBin = assertSuccess(
      "bun global bin discovery",
      await run(
        [bunExecutable, "pm", "bin", "--global"],
        options.commandOptions,
      ),
    );
    if (!isAbsolute(globalBin)) {
      throw new Error("Bun global bin directory is not absolute");
    }
    binaryPath = join(globalBin, executable);
  }
  const binaryRealPath = await realpath(binaryPath);
  const packageRoot = await findPackageRoot(
    binaryRealPath,
    "@earendil-works/pi-coding-agent",
  );
  if (excludedPackageRoots.some((root) => isWithin(root, packageRoot))) {
    throw new Error("discovered pi resolved to an excluded package root");
  }
  const codingManifest = await readManifest(packageRoot);
  const packageName = codingManifest.name;
  const packageVersion = codingManifest.version;
  if (
    packageName !== "@earendil-works/pi-coding-agent" ||
    typeof packageVersion !== "string"
  ) {
    throw new Error("global pi package manifest lacks name/version");
  }
  const globalModules = findNodeModulesRoot(packageRoot);
  const binTarget = codingManifest.bin?.pi;
  if (typeof binTarget !== "string")
    throw new Error("global pi manifest lacks bin.pi");
  if (
    !isWithin(packageRoot, binaryRealPath) ||
    (await realpath(join(packageRoot, binTarget))) !== binaryRealPath
  ) {
    throw new Error(
      "global pi binary does not belong to the discovered package",
    );
  }
  const packageCohort = new Set(piCohortPackagesForVersion(packageVersion));
  const corePackages: Record<string, PiCorePackage> = {};
  for (const name of packageCohort) {
    const root = join(globalModules, ...name.split("/"));
    const canonicalRoot = await realpath(root);
    if (
      (name === packageName && root !== packageRoot) ||
      canonicalRoot !== root ||
      excludedPackageRoots.some((excluded) => isWithin(excluded, root))
    ) {
      throw new Error(`global package root mismatch: expected ${name}`);
    }
    const manifest =
      name === packageName ? codingManifest : await readManifest(root);
    if (manifest.name !== name) {
      throw new Error(`global package root mismatch: expected ${name}`);
    }
    if (
      typeof manifest.version !== "string" ||
      parseVersion(manifest.version) === undefined
    ) {
      throw new Error(`${name} manifest lacks a version`);
    }
    corePackages[name] = {
      root,
      version: manifest.version,
      manifest,
    };
    for (const dependency of [PI_SCHEMA_PACKAGE, PI_CHORD_PACKAGE] as const) {
      if (Object.hasOwn(manifest.dependencies ?? {}, dependency)) {
        packageCohort.add(dependency);
      }
    }
  }

  for (const [owner, pkg] of Object.entries(corePackages)) {
    for (const [dependency, range] of Object.entries(
      pkg.manifest.dependencies ?? {},
    )) {
      if (!Object.hasOwn(corePackages, dependency)) continue;
      const installed = corePackages[dependency];
      if (installed === undefined) continue;
      if (!satisfiesManifestRange(installed.version, range)) {
        throw new Error(
          `${owner} requires ${dependency}@${range}, installed ${installed?.version ?? "missing"}`,
        );
      }
    }
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
