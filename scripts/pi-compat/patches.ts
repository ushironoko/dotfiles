import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PiInstallation } from "./installation";
import { runCommand, type CommandResult, type CommandRunner } from "./process";

export interface PiPatchSpec {
  packageName: string;
  version: string;
  file: string;
}

export interface PiPatchResult {
  packageName: string;
  version: string;
  status: "pending" | "applied" | "already-applied";
}

export interface ApplyPiPatchesOptions {
  repoRoot?: string;
  run?: CommandRunner;
  specs?: readonly PiPatchSpec[];
  allowUnsupported?: boolean;
  checkOnly?: boolean;
  verify?: () => Promise<void>;
}

export const PI_RUNTIME_PATCHES: readonly PiPatchSpec[] = [
  {
    packageName: "@earendil-works/pi-tui",
    version: "0.83.0",
    file: "patches/@earendil-works%2Fpi-tui@0.83.0.patch",
  },
  {
    packageName: "@earendil-works/pi-coding-agent",
    version: "0.83.0",
    file: "patches/@earendil-works%2Fpi-coding-agent@0.83.0.patch",
  },
];

const succeeded = (result: CommandResult): boolean =>
  !result.timedOut && result.exitCode === 0;

const failureSummary = (result: CommandResult): string =>
  (result.stderr || result.stdout || `exit ${result.exitCode ?? "signal"}`)
    .trim()
    .slice(0, 2_000);

const checkPatch = async (
  run: CommandRunner,
  packageRoot: string,
  patchPath: string,
  reverse: boolean,
): Promise<CommandResult> =>
  run(
    [
      "git",
      "apply",
      ...(reverse ? ["--reverse"] : []),
      "--check",
      "--whitespace=nowarn",
      patchPath,
    ],
    { cwd: packageRoot, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
  );

interface PatchPlan {
  spec: PiPatchSpec;
  packageRoot: string;
  patchPath: string;
  targets: string[];
  status: "pending" | "already-applied";
}

const isWithin = (root: string, target: string): boolean => {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
};

const patchTargets = async (
  packageRoot: string,
  patchPath: string,
): Promise<string[]> => {
  const canonicalRoot = await realpath(packageRoot);
  const targets = new Set<string>();
  const source = await readFile(patchPath, "utf8");
  for (const line of source.split("\n")) {
    if (!line.startsWith("+++ b/")) continue;
    const path = line.slice("+++ b/".length).split("\t", 1)[0] ?? "";
    if (
      path === "" ||
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith(`..${sep}`)
    ) {
      throw new Error(`unsafe sticky patch target: ${path || "empty"}`);
    }
    const target = resolve(canonicalRoot, path);
    if (!isWithin(canonicalRoot, target)) {
      throw new Error(`sticky patch target escapes package root: ${path}`);
    }
    const metadata = await lstat(target);
    if (!metadata.isFile()) {
      throw new Error(`sticky patch target is not a regular file: ${path}`);
    }
    const canonicalTarget = await realpath(target);
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      throw new Error(
        `sticky patch target resolves outside package root: ${path}`,
      );
    }
    targets.add(canonicalTarget);
  }
  if (targets.size === 0) {
    throw new Error(`sticky patch has no existing file targets: ${patchPath}`);
  }
  return [...targets];
};

const detachFile = async (path: string): Promise<void> => {
  const temporary = `${path}.pi-patch-${process.pid}-${randomUUID()}.tmp`;
  try {
    await copyFile(path, temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const applyPiPatches = async (
  installation: PiInstallation,
  options: ApplyPiPatchesOptions = {},
): Promise<PiPatchResult[]> => {
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "../..");
  const run = options.run ?? runCommand;
  const specs = options.specs ?? PI_RUNTIME_PATCHES;
  const selectedSpecs: PiPatchSpec[] = [];
  const packageNames = new Set(specs.map(({ packageName }) => packageName));
  for (const packageName of packageNames) {
    const installed = installation.corePackages[packageName];
    if (installed === undefined) {
      throw new Error(`pi patch package is not installed: ${packageName}`);
    }
    const matching = specs.filter(
      (spec) =>
        spec.packageName === packageName && spec.version === installed.version,
    );
    if (matching.length === 0) {
      if (options.allowUnsupported) return [];
      const available = specs
        .filter((spec) => spec.packageName === packageName)
        .map(({ version }) => version)
        .join(", ");
      throw new Error(
        `no ${packageName} sticky patch for ${installed.version}; available: ${available}`,
      );
    }
    selectedSpecs.push(...matching);
  }

  const plans: PatchPlan[] = [];
  // Validate every package and patch before mutating any global package.
  for (const spec of selectedSpecs) {
    const installed = installation.corePackages[spec.packageName];
    if (installed === undefined) {
      throw new Error(`pi patch package is not installed: ${spec.packageName}`);
    }
    const patchPath = join(repoRoot, spec.file);
    await access(patchPath);
    const targets = await patchTargets(installed.root, patchPath);
    const pending = await checkPatch(run, installed.root, patchPath, false);
    if (succeeded(pending)) {
      plans.push({
        spec,
        packageRoot: installed.root,
        patchPath,
        targets,
        status: "pending",
      });
      continue;
    }

    const alreadyApplied = await checkPatch(
      run,
      installed.root,
      patchPath,
      true,
    );
    if (!succeeded(alreadyApplied)) {
      throw new Error(
        `${spec.packageName} ${spec.version} does not match either side of its sticky patch: ${failureSummary(pending)}; reverse: ${failureSummary(alreadyApplied)}`,
      );
    }
    plans.push({
      spec,
      packageRoot: installed.root,
      patchPath,
      targets,
      status: "already-applied",
    });
  }

  if (options.checkOnly) {
    return plans.map(({ spec, status }) => ({
      packageName: spec.packageName,
      version: spec.version,
      status: status === "pending" ? "pending" : "already-applied",
    }));
  }

  const appliedPlans: PatchPlan[] = [];
  const detachedTargets = new Set<string>();
  try {
    for (const plan of plans) {
      if (plan.status === "already-applied") continue;
      for (const target of plan.targets) {
        if (detachedTargets.has(target)) continue;
        await detachFile(target);
        detachedTargets.add(target);
      }
      const applied = await run(
        ["git", "apply", "--whitespace=nowarn", plan.patchPath],
        {
          cwd: plan.packageRoot,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (!succeeded(applied)) {
        throw new Error(
          `failed to apply ${plan.spec.packageName} sticky patch: ${failureSummary(applied)}`,
        );
      }
      appliedPlans.push(plan);
      const verified = await checkPatch(
        run,
        plan.packageRoot,
        plan.patchPath,
        true,
      );
      if (!succeeded(verified)) {
        throw new Error(
          `could not verify ${plan.spec.packageName} sticky patch after apply: ${failureSummary(verified)}`,
        );
      }
    }
    await options.verify?.();
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const plan of appliedPlans.reverse()) {
      const rolledBack = await run(
        ["git", "apply", "--reverse", "--whitespace=nowarn", plan.patchPath],
        {
          cwd: plan.packageRoot,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (!succeeded(rolledBack)) {
        rollbackFailures.push(
          `${plan.spec.packageName}: ${failureSummary(rolledBack)}`,
        );
      }
    }
    const rollbackSuffix =
      rollbackFailures.length === 0
        ? ""
        : `; patch rollback failed: ${rollbackFailures.join("; ")}`;
    throw new Error(`${String(error)}${rollbackSuffix}`);
  }

  return plans.map(({ spec, status }) => ({
    packageName: spec.packageName,
    version: spec.version,
    status: status === "pending" ? "applied" : "already-applied",
  }));
};
