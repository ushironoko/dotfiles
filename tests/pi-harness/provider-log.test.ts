import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupProviderLog from "../../pi/extensions/pi-harness/features/provider-log/index";
import {
  buildRequestRecord,
  buildResponseRecord,
  selectExpiredLogs,
} from "../../pi/extensions/pi-harness/features/provider-log/record";
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

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": true,
    "asuku-notify": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

const NOW = new Date("2026-07-11T12:00:00.000Z");

describe("provider-log records", () => {
  test("request record keeps metadata plus a body hash, never the body", () => {
    const event = {
      type: "before_provider_request",
      request: {
        model: "claude-opus-4-8",
        system: "You are concise.",
        messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      },
    };
    const record = buildRequestRecord(event, NOW);
    expect(record.kind).toBe("request");
    expect(record.ts).toBe(NOW.toISOString());
    expect(record.model).toBe("claude-opus-4-8");
    expect(record.messageCount).toBe(3);
    expect(record.systemChars).toBe("You are concise.".length);
    expect(record.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("You are concise.");
  });

  test("request record hash is stable and shape-tolerant", () => {
    const event = { type: "before_provider_request", model: "m1" };
    const first = buildRequestRecord(event, NOW);
    const second = buildRequestRecord(event, NOW);
    expect(first.bodySha256).toBe(second.bodySha256);
    expect(first.model).toBe("m1");
    expect(first.messageCount).toBeUndefined();
    expect(buildRequestRecord("garbage", NOW).kind).toBe("request");
  });

  test("response record keeps status and only allowlisted headers", () => {
    const event = {
      type: "after_provider_response",
      status: 429,
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "anthropic-ratelimit-requests-remaining": "0",
        "X-RateLimit-Reset": "17",
        "request-id": "req_123",
        cookie: "nope",
      },
    };
    const record = buildResponseRecord(event, NOW);
    expect(record.kind).toBe("response");
    expect(record.status).toBe(429);
    expect(record.headers).toEqual({
      "content-type": "application/json",
      "anthropic-ratelimit-requests-remaining": "0",
      "x-ratelimit-reset": "17",
      "request-id": "req_123",
    });
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  test("response record tolerates missing fields", () => {
    const record = buildResponseRecord(
      { type: "after_provider_response" },
      NOW,
    );
    expect(record.status).toBeUndefined();
    expect(record.headers).toEqual({});
  });

  test("selectExpiredLogs picks only dated log files beyond retention", () => {
    const names = [
      "provider-2026-07-11.jsonl",
      "provider-2026-07-01.jsonl",
      "provider-2026-06-01.jsonl",
      "unrelated.txt",
      "provider-not-a-date.jsonl",
    ];
    expect(selectExpiredLogs(names, NOW, 14)).toEqual([
      "provider-2026-06-01.jsonl",
    ]);
  });
});

describe("pi-harness provider-log feature", () => {
  test("writes request/response JSONL with restrictive permissions", async () => {
    const home = await makeTempDirectory("pi-provider-log");
    const config = makeConfig(home);
    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });

    await pi.emitBeforeProviderRequest({
      type: "before_provider_request",
      model: "claude-opus-4-8",
    });
    await pi.emitAfterProviderResponse({
      type: "after_provider_response",
      status: 200,
      headers: { "request-id": "req_9" },
    });
    await pi.emitSessionShutdown();

    const logFile = join(config.paths.logDir, "provider-2026-07-11.jsonl");
    const lines = (await fs.readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("request");
    expect(lines[1].kind).toBe("response");
    expect(lines[1].headers["request-id"]).toBe("req_9");

    const dirMode = (await fs.stat(config.paths.logDir)).mode & 0o777;
    const fileMode = (await fs.stat(logFile)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  test("expired log files are removed by retention", async () => {
    const home = await makeTempDirectory("pi-provider-retention");
    const config = makeConfig(home);
    await fs.mkdir(config.paths.logDir, { recursive: true });
    const expired = join(config.paths.logDir, "provider-2026-06-01.jsonl");
    const kept = join(config.paths.logDir, "provider-2026-07-10.jsonl");
    await fs.writeFile(expired, "{}\n");
    await fs.writeFile(kept, "{}\n");

    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });
    await pi.emitBeforeProviderRequest({ type: "before_provider_request" });
    await pi.emitSessionShutdown();

    await expect(fs.access(expired)).rejects.toThrow();
    // Throws if retention removed the file it should have kept.
    await fs.access(kept);
  });

  test("enforces 0700 on a pre-existing loose log directory", async () => {
    const home = await makeTempDirectory("pi-provider-dirperm");
    const config = makeConfig(home);
    await fs.mkdir(config.paths.logDir, { recursive: true });
    await fs.chmod(config.paths.logDir, 0o755);

    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });
    await pi.emitBeforeProviderRequest({ type: "before_provider_request" });
    await pi.emitSessionShutdown();

    expect((await fs.stat(config.paths.logDir)).mode & 0o777).toBe(0o700);
  });

  test("enforces 0600 on a pre-existing loose log file", async () => {
    const home = await makeTempDirectory("pi-provider-fileperm");
    const config = makeConfig(home);
    const logFile = join(config.paths.logDir, "provider-2026-07-11.jsonl");
    await fs.mkdir(config.paths.logDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(logFile, "");
    await fs.chmod(logFile, 0o644);

    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });
    await pi.emitBeforeProviderRequest({ type: "before_provider_request" });
    await pi.emitSessionShutdown();

    expect((await fs.stat(logFile)).mode & 0o777).toBe(0o600);
  });

  test("refuses to follow a symlinked log file and never touches its target", async () => {
    const home = await makeTempDirectory("pi-provider-symlink");
    const config = makeConfig(home);
    const logFile = join(config.paths.logDir, "provider-2026-07-11.jsonl");
    const victim = join(home, "victim.txt");
    await fs.mkdir(config.paths.logDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(victim, "original");
    await fs.symlink(victim, logFile);

    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });
    await pi.emitBeforeProviderRequest({ type: "before_provider_request" });
    await pi.emitSessionShutdown(); // must not throw

    expect(await fs.readFile(victim, "utf8")).toBe("original");
  });

  test("session_shutdown resolves even when the log dir cannot be created", async () => {
    const home = await makeTempDirectory("pi-provider-unwritable");
    const config = makeConfig(home);
    // A regular file sits where the log dir should be → mkdir fails → the flush
    // drops the records instead of throwing.
    await fs.mkdir(dirname(config.paths.logDir), { recursive: true });
    await fs.writeFile(config.paths.logDir, "not a dir");

    const pi = createFakePi({ cwd: home });
    setupProviderLog(pi, config, { now: () => NOW });
    await pi.emitBeforeProviderRequest({ type: "before_provider_request" });
    await expect(pi.emitSessionShutdown()).resolves.toBeUndefined();
  });
});
