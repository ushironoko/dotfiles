import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const PI_BASELINE_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

const DIRECT_PI_PINS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
] as const;
const DIRECT_PI_PIN_SET = new Set<string>(DIRECT_PI_PINS);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type BaselinePackage = (typeof PI_BASELINE_PACKAGES)[number];

interface PackageManifest {
  name?: string;
  version?: string;
  devDependencies?: Record<string, string | undefined>;
}

interface Lockfile {
  workspaces?: {
    ""?: {
      devDependencies?: Record<string, string | undefined>;
    };
  };
  packages?: Record<string, unknown>;
}

export interface PiBaselinePackageState {
  name: BaselinePackage;
  lockedVersion?: string;
  installedVersion?: string;
  installedRoot?: string;
}

export interface PiBaselineResult {
  ok: boolean;
  issues: string[];
  packages: PiBaselinePackageState[];
}

const readJsonc = async <T>(path: string): Promise<T> => {
  // Bun 1.3 exposes JSONC at runtime; the repository's intentionally pinned
  // Bun 1.2 type package does not declare it yet.
  const { JSONC } = Bun as unknown as {
    JSONC: { parse(source: string): unknown };
  };
  return JSONC.parse(await readFile(path, "utf8")) as T;
};

const versionFromLockEntry = (
  name: string,
  entry: unknown,
): string | undefined => {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined;
  const prefix = `${name}@`;
  return entry[0].startsWith(prefix)
    ? entry[0].slice(prefix.length)
    : undefined;
};

const installedPackage = async (
  repoRoot: string,
  name: BaselinePackage,
): Promise<{ root?: string; version?: string }> => {
  const root = join(repoRoot, "node_modules", ...name.split("/"));
  try {
    const canonicalRoot = await realpath(root);
    const canonicalModules = await realpath(join(repoRoot, "node_modules"));
    if (relative(canonicalModules, canonicalRoot).startsWith("..")) return {};
    const manifest = await readJsonc<PackageManifest>(
      join(canonicalRoot, "package.json"),
    );
    return { root: canonicalRoot, version: manifest.version };
  } catch {
    return {};
  }
};

export const checkLocalPiBaseline = async (
  repoRoot: string = resolve(import.meta.dir, "../.."),
): Promise<PiBaselineResult> => {
  const packageJson = await readJsonc<PackageManifest>(
    join(repoRoot, "package.json"),
  );
  const lock = await readJsonc<Lockfile>(join(repoRoot, "bun.lock"));
  const issues: string[] = [];
  const workspacePins = lock.workspaces?.[""]?.devDependencies ?? {};

  for (const name of DIRECT_PI_PINS) {
    const manifestPin = packageJson.devDependencies?.[name];
    const lockPin = workspacePins[name];
    if (manifestPin === undefined) {
      issues.push(`direct-pin: ${name} is missing from package.json`);
    } else if (!EXACT_VERSION.test(manifestPin)) {
      issues.push(
        `direct-pin: ${name} must use an exact version (${manifestPin})`,
      );
    } else if (lockPin !== manifestPin) {
      issues.push(
        `lock-pin: ${name} package.json=${manifestPin} bun.lock=${lockPin ?? "missing"}`,
      );
    }
  }

  const packages: PiBaselinePackageState[] = [];
  for (const name of PI_BASELINE_PACKAGES) {
    const lockedVersion = versionFromLockEntry(name, lock.packages?.[name]);
    const installed = await installedPackage(repoRoot, name);
    packages.push({
      name,
      lockedVersion,
      installedVersion: installed.version,
      installedRoot: installed.root,
    });
    const directPin = packageJson.devDependencies?.[name];
    if (
      DIRECT_PI_PIN_SET.has(name) &&
      lockedVersion !== undefined &&
      directPin !== undefined &&
      lockedVersion !== directPin
    ) {
      issues.push(
        `resolved-pin: ${name} resolved=${lockedVersion} direct=${directPin}`,
      );
    }
    if (lockedVersion === undefined) {
      issues.push(`lock-tree: ${name} has no resolved bun.lock entry`);
    } else if (installed.version === undefined) {
      issues.push(`installed-tree: ${name} is not installed`);
    } else if (installed.version !== lockedVersion) {
      issues.push(
        `installed-tree: ${name} installed=${installed.version} locked=${lockedVersion}`,
      );
    }
  }

  return { ok: issues.length === 0, issues, packages };
};

export const assertLocalPiBaseline = async (
  repoRoot?: string,
): Promise<PiBaselineResult> => {
  const result = await checkLocalPiBaseline(repoRoot);
  if (!result.ok) {
    throw new Error(
      `pi baseline is inconsistent:\n${result.issues.map((issue) => `  - ${issue}`).join("\n")}\nRun: bun install --frozen-lockfile`,
    );
  }
  return result;
};

if (import.meta.main) {
  try {
    const result = await assertLocalPiBaseline();
    console.log(
      `check-pi-baseline: OK (${result.packages.map(({ name, lockedVersion }) => `${name}@${lockedVersion}`).join(", ")})`,
    );
  } catch (error) {
    console.error(`check-pi-baseline: ${String(error)}`);
    process.exit(1);
  }
}
