import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  loadConfig,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import setupTrustPrompt from "../../pi/extensions/pi-harness/features/trust-prompt/index";
import type { RunBoundedCommand } from "../../pi/extensions/pi-harness/lib/bounded-process";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import {
  appendTrustedRoot,
  matchedTrustedRoot,
} from "../../pi/extensions/pi-harness/lib/trust";
import { createFakePi } from "./fake-pi";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const created = await mkdtemp(join(tmpdir(), "pi-trust-prompt-"));
  const root = await realpath(created);
  roots.push(root);
  return root;
};

const configFor = (home: string): HarnessConfig =>
  loadConfig({}, resolvePaths(home));

const successfulGitRoot =
  (root: string): RunBoundedCommand =>
  async (_command, _args, _options) => ({
    exitCode: 0,
    stdout: Buffer.from(`${root}\n`),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
  });

const untrustedRepository = async () => "untrusted" as const;
const trustedRepository = async () => "trusted" as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pi-harness startup trust prompt", () => {
  test("persists approval without discarding local settings and activates trust immediately", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    await mkdir(repository);
    const config = configFor(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      config.paths.localConfigFile,
      `${JSON.stringify({ features: { statusline: false }, custom: { kept: true } })}\n`,
      { mode: 0o640 },
    );

    let gitEnvironment: Record<string, string> | undefined;
    const git = successfulGitRoot(repository);
    const runCommand: RunBoundedCommand = async (command, args, options) => {
      gitEnvironment = options.env;
      return git(command, args, options);
    };
    const pi = createFakePi({ cwd: repository });
    pi.queueConfirm(true);
    setupTrustPrompt(pi, config, {
      env: {
        PATH: `${join(repository, "bin")}:/usr/bin`,
        GIT_DIR: join(repository, "spoofed-git-dir"),
      },
      runCommand,
      repositoryTrust: untrustedRepository,
      attemptedRoots: new Set(),
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(pi.confirmDialogs).toHaveLength(1);
    expect(gitEnvironment?.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(gitEnvironment?.GIT_DIR).toBeUndefined();
    expect(pi.confirmDialogs[0]).toMatchObject({
      title: "Trust this repository?",
      message: expect.stringContaining(repository),
    });
    const persisted = JSON.parse(
      await readFile(config.paths.localConfigFile, "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      features: { statusline: false },
      custom: { kept: true },
      trustedRoots: [repository],
    });
    const configStat = await stat(config.paths.localConfigFile);
    expect(configStat.mode & 0o777).toBe(0o640);
    expect(config.trust.trustedRoots).toEqual([repository]);
    expect(pi.notifications).toContainEqual({
      message: `Trusted repository: ${repository}`,
      level: "info",
    });
  });

  test("does not write after denial or ask for the same root twice", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    await mkdir(repository);
    const config = configFor(home);
    const pi = createFakePi({ cwd: repository });
    pi.queueConfirm(false);
    setupTrustPrompt(pi, config, {
      runCommand: successfulGitRoot(repository),
      repositoryTrust: untrustedRepository,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    const reloaded = createFakePi({ cwd: repository });
    reloaded.queueConfirm(true);
    setupTrustPrompt(reloaded, config, {
      runCommand: successfulGitRoot(repository),
      repositoryTrust: untrustedRepository,
    });
    await reloaded.emitSessionStart({
      type: "session_start",
      reason: "reload",
    });

    expect(pi.confirmDialogs).toHaveLength(1);
    expect(reloaded.confirmDialogs).toHaveLength(0);
    expect(config.trust.trustedRoots).toEqual([]);
    await expect(
      readFile(config.paths.localConfigFile, "utf8"),
    ).rejects.toThrow();
  });

  test("skips non-interactive and already trusted sessions", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    await mkdir(repository);
    let commands = 0;
    const invoke: RunBoundedCommand = async (...args) => {
      commands += 1;
      return successfulGitRoot(repository)(...args);
    };

    const nonInteractiveConfig = configFor(home);
    const nonInteractive = createFakePi({
      cwd: repository,
      hasUI: false,
      mode: "print",
    });
    setupTrustPrompt(nonInteractive, nonInteractiveConfig, {
      runCommand: invoke,
      repositoryTrust: untrustedRepository,
      attemptedRoots: new Set(),
    });
    await nonInteractive.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });

    const trustedConfig = configFor(home);
    trustedConfig.trust.trustedRoots.push(repository);
    const trusted = createFakePi({ cwd: repository });
    setupTrustPrompt(trusted, trustedConfig, {
      runCommand: invoke,
      repositoryTrust: trustedRepository,
      attemptedRoots: new Set(),
    });
    await trusted.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });

    expect(commands).toBe(1);
    expect(nonInteractive.confirmDialogs).toEqual([]);
    expect(trusted.confirmDialogs).toEqual([]);
  });

  test("prompts for a nested Git repository that project memory does not inherit trust for", async () => {
    const home = await temporaryRoot();
    const outer = join(home, "outer");
    const nested = join(outer, "nested");
    await execFileAsync("git", ["init", "-q", outer]);
    await execFileAsync("git", ["init", "-q", nested]);
    const config = configFor(home);
    config.trust.trustedRoots.push(outer);
    const pi = createFakePi({ cwd: nested });
    pi.queueConfirm(false);
    setupTrustPrompt(pi, config, { attemptedRoots: new Set() });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(pi.confirmDialogs).toHaveLength(1);
    expect(pi.confirmDialogs[0]?.message).toContain(nested);
    expect(matchedTrustedRoot(nested, config.trust)).toBeUndefined();
  });

  test("fails closed when the existing local config is malformed", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    await mkdir(repository);
    const config = configFor(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(config.paths.localConfigFile, "{not-json\n");
    const attemptedRoots = new Set<string>();
    const pi = createFakePi({ cwd: repository });
    pi.queueConfirm(true);
    setupTrustPrompt(pi, config, {
      runCommand: successfulGitRoot(repository),
      repositoryTrust: untrustedRepository,
      attemptedRoots,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(config.trust.trustedRoots).toEqual([]);
    expect(attemptedRoots.size).toBe(0);
    expect(await readFile(config.paths.localConfigFile, "utf8")).toBe(
      "{not-json\n",
    );
    expect(pi.notifications).toContainEqual({
      message:
        "Could not trust repository: pi-harness.local.json could not be parsed",
      level: "error",
    });
  });

  test("preserves trailing spaces in the canonical Git top-level", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository ");
    await mkdir(repository);
    const config = configFor(home);
    const pi = createFakePi({ cwd: repository });
    pi.queueConfirm(true);
    setupTrustPrompt(pi, config, {
      runCommand: successfulGitRoot(repository),
      repositoryTrust: untrustedRepository,
      attemptedRoots: new Set(),
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(config.trust.trustedRoots).toEqual([repository]);
    expect(pi.confirmDialogs[0]?.message).toContain(`${repository}\n\n`);
  });

  test("preserves the existing mode under a restrictive umask", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    const configFile = join(home, "pi-harness.local.json");
    await mkdir(repository);
    await writeFile(configFile, "{}\n", { mode: 0o640 });

    const previousUmask = process.umask(0o077);
    try {
      appendTrustedRoot(configFile, repository);
    } finally {
      process.umask(previousUmask);
    }

    const configStat = await stat(configFile);
    expect(configStat.mode & 0o777).toBe(0o640);
  });

  test("refuses a competing local-config writer without losing data", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    const configFile = join(home, "pi-harness.local.json");
    const lockFile = join(home, ".pi-harness.local.json.lock");
    await mkdir(repository);
    await writeFile(configFile, '{"custom":"keep"}\n');
    await writeFile(lockFile, "another-writer");

    expect(() => appendTrustedRoot(configFile, repository)).toThrow(
      "pi-harness.local.json update already in progress",
    );
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      custom: "keep",
    });
  });

  test("prioritizes an approved root inside project memory's bounded scan window", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    const configFile = join(home, "pi-harness.local.json");
    const staleRoots = Array.from({ length: 64 }, (_, index) =>
      join(home, `stale-${index}`),
    );
    await mkdir(repository);
    await writeFile(
      configFile,
      `${JSON.stringify({ trustedRoots: staleRoots })}\n`,
    );

    const updated = appendTrustedRoot(configFile, repository);

    expect(updated.trustedRoots[0]).toBe(repository);
    expect(updated.trustedRoots.slice(1)).toEqual(staleRoots);
  });

  test("recovers an expired orphaned local-config lock", async () => {
    const home = await temporaryRoot();
    const repository = join(home, "repository");
    const configFile = join(home, "pi-harness.local.json");
    const lockFile = join(home, ".pi-harness.local.json.lock");
    await mkdir(repository);
    await writeFile(configFile, "{}\n");
    await writeFile(lockFile, "crashed-writer");
    const staleTime = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockFile, staleTime, staleTime);

    expect(appendTrustedRoot(configFile, repository)).toEqual({
      trustedRoots: [repository],
    });
    await expect(readFile(lockFile, "utf8")).rejects.toThrow();
  });

  test("updates a symlink target without replacing the machine-local symlink", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    const target = join(root, "local-config.json");
    const link = join(root, "pi-harness.local.json");
    await mkdir(repository);
    await writeFile(target, '{"custom":true}\n');
    await symlink(target, link);

    expect(appendTrustedRoot(link, repository)).toEqual({
      trustedRoots: [repository],
    });

    const linkStat = await lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      custom: true,
      trustedRoots: [repository],
    });
  });
});
