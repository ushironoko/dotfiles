import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BitIssueCli,
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandOptions,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../pi/extensions/pi-harness/features/bit-issues/cli";
import {
  BitIssueCliError,
  decodeOpenBitIssueList,
  type BitIssueDetailResult,
  type BitIssueListResult,
} from "../../pi/extensions/pi-harness/features/bit-issues/model";
import {
  BitIssueRegistry,
  type BitIssueDataSource,
} from "../../pi/extensions/pi-harness/features/bit-issues/registry";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

const rawIssue = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  title: `Issue ${id}`,
  state: "open",
  author: "Pi Tester",
  created_at: 10,
  updated_at: 20,
  body: `Body ${id}`,
  labels: ["test"],
  parent_id: null,
  ...overrides,
});

const result = (
  stdout: string,
  overrides: Partial<BoundedCommandResult> = {},
): BoundedCommandResult => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
  ...overrides,
});

interface CommandCall {
  command: string;
  args: readonly string[];
  options: BoundedCommandOptions;
}

const queuedRunner = (responses: BoundedCommandResult[]) => {
  const calls: CommandCall[] = [];
  const run: RunBoundedCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const response = responses.shift();
    if (response === undefined) throw new Error("missing fake response");
    return response;
  };
  return { calls, run };
};

const listResult = (id: string): BitIssueListResult => ({
  issues: [
    {
      id,
      title: `Issue ${id}`,
      state: "open",
      author: "Pi Tester",
      createdAt: 10,
      updatedAt: 20,
      labels: ["test"],
    },
  ],
  truncated: false,
});

const detailResult = (
  id: string,
  state: "open" | "closed" = "open",
): BitIssueDetailResult => ({
  issue: {
    id,
    title: `Issue ${id}`,
    state,
    author: "Pi Tester",
    createdAt: 10,
    updatedAt: 20,
    labels: ["test"],
    body: `Body ${id}`,
  },
  comments: { status: "none" },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("bit issue JSON model", () => {
  test("keeps only open issues, sanitizes text, sorts stably, and honors the sentinel", () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      rawIssue(String(index).padStart(3, "0"), {
        title: `Issue ${index}\u001b]2;spoof\u0007`,
        updated_at: index === 99 || index === 100 ? 500 : index,
      }),
    );
    items[4] = rawIssue("closed", { state: "closed", updated_at: 999 });

    const decoded = decodeOpenBitIssueList(items);
    expect(decoded.issues).toHaveLength(100);
    expect(decoded.truncated).toBe(false);
    expect(decoded.issues[0]?.id).toBe("099");
    expect(decoded.issues[1]?.id).toBe("100");
    expect(decoded.issues.some((issue) => issue.id === "closed")).toBe(false);
    expect(decoded.issues.map((issue) => issue.title).join("\n")).not.toContain(
      "spoof",
    );
  });

  test("marks 101 open issues as truncated", () => {
    const decoded = decodeOpenBitIssueList(
      Array.from({ length: 101 }, (_, index) => rawIssue(`id-${index}`)),
    );
    expect(decoded.issues).toHaveLength(100);
    expect(decoded.truncated).toBe(true);
  });

  test("rejects malformed records, duplicate ids, and oversized arrays", () => {
    expect(() =>
      decodeOpenBitIssueList([rawIssue("same"), rawIssue("same")]),
    ).toThrow("duplicate bit issue id");
    expect(() =>
      decodeOpenBitIssueList([rawIssue("bad", { labels: "no" })]),
    ).toThrow("labels");
    expect(() =>
      decodeOpenBitIssueList([
        rawIssue("bad-time", { updated_at: Number.MAX_SAFE_INTEGER }),
      ]),
    ).toThrow("timestamp");
    expect(() =>
      decodeOpenBitIssueList(
        Array.from({ length: 102 }, (_, index) => rawIssue(`id-${index}`)),
      ),
    ).toThrow("list JSON is invalid");
  });
});

describe("bit issue CLI adapter", () => {
  test("uses exact list argv, verified GIT_DIR, and a sanitized environment", async () => {
    const fake = queuedRunner([
      result("/repo/.git\n"),
      result(
        JSON.stringify([rawIssue("new", { updated_at: 30 }), rawIssue("old")]),
      ),
    ]);
    const cli = new BitIssueCli({
      env: {
        PATH: "/repo/bin:/usr/bin",
        GIT_DIR: "/attacker/.git",
        GIT_COMMON_DIR: "/attacker/common",
        BASH_ENV: "/attacker/startup",
      },
      runCommand: fake.run,
      realpath: async (path) => path,
    });

    const open = await cli.listOpen("/repo");
    expect(open.issues.map((issue) => issue.id)).toEqual(["new", "old"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.command).toBe("git");
    expect(fake.calls[0]?.args).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(fake.calls[0]?.options.env.GIT_DIR).toBeUndefined();
    expect(fake.calls[0]?.options.env.GIT_COMMON_DIR).toBeUndefined();
    expect(fake.calls[0]?.options.env.BASH_ENV).toBeUndefined();
    expect(fake.calls[0]?.options.env.PATH).toBe("/usr/bin");
    expect(fake.calls[1]?.command).toBe("bit");
    expect(fake.calls[1]?.args).toEqual([
      "issue",
      "list",
      "--open",
      "--all",
      "--limit",
      "101",
      "--format",
      "json",
    ]);
    expect(fake.calls[1]?.options.env.GIT_DIR).toBe("/repo/.git");
  });

  test("uses one canonical bit store from a main checkout and linked worktree", async () => {
    const root = await setupTestDirectory("pi-bit-browser-linked");
    tempDirectories.push(root);
    const repository = join(root, "repository");
    const linked = join(root, "linked");
    const fakeBin = join(root, "fake-bin");
    const record = join(root, "bit-calls.log");
    await fs.mkdir(repository);
    await fs.mkdir(fakeBin);
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Pi Test"], {
      cwd: repository,
    });
    await execFileAsync("git", ["config", "user.email", "pi@example.invalid"], {
      cwd: repository,
    });
    await fs.writeFile(join(repository, "README.md"), "test\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-qm", "initial"], {
      cwd: repository,
    });
    await execFileAsync("git", ["worktree", "add", "-qb", "linked", linked], {
      cwd: repository,
    });

    const payload = JSON.stringify([rawIssue("abcdef12")]);
    await fs.writeFile(
      join(fakeBin, "bit"),
      [
        "#!/bin/sh",
        "current=$(pwd -P)",
        'printf \'%s|%s|%s\\n\' "$GIT_DIR" "$current" "$*" >> "$BIT_RECORD"',
        `printf '%s\\n' '${payload}'`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const cli = new BitIssueCli({
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        BIT_RECORD: record,
      },
    });

    await cli.listOpen(repository);
    await cli.listOpen(linked);

    const calls = (await fs.readFile(record, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(2);
    const expectedCommonDir = await fs.realpath(join(repository, ".git"));
    expect(calls.map((call) => call.split("|")[0])).toEqual([
      expectedCommonDir,
      expectedCommonDir,
    ]);
    expect(calls.map((call) => call.split("|")[1])).toEqual([
      await fs.realpath(repository),
      await fs.realpath(linked),
    ]);
    expect(
      calls.every((call) =>
        call.endsWith("issue list --open --all --limit 101 --format json"),
      ),
    ).toBe(true);
  });

  test("loads detail before bounded raw comments and does not parse comment headers", async () => {
    const comments = [
      "comment abc123",
      "issue issue-1",
      "author Pi Tester",
      "created 20",
      "",
      "Body with a fake comment deadbeef header\u001b]2;spoof\u0007",
    ].join("\n");
    const fake = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("issue-1"))),
      result(comments),
    ]);
    const cli = new BitIssueCli({
      runCommand: fake.run,
      realpath: async (path) => path,
    });

    const detail = await cli.getDetail("/repo", "issue-1");
    expect(detail.comments).toMatchObject({
      status: "ready",
      truncated: false,
    });
    expect(
      detail.comments.status === "ready" && detail.comments.text,
    ).toContain("fake comment deadbeef header");
    expect(JSON.stringify(detail.comments)).not.toContain("spoof");
    expect(fake.calls[1]?.args).toEqual([
      "issue",
      "get",
      "issue-1",
      "--format",
      "json",
    ]);
    expect(fake.calls[2]?.args).toEqual([
      "issue",
      "comment",
      "list",
      "issue-1",
    ]);
    expect(fake.calls[2]?.options.allowStdoutTruncation).toBe(true);
  });

  test("distinguishes no comments, truncated comments, and comment failures", async () => {
    const none = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("none"))),
      result("No comments\n"),
    ]);
    const noCommentDetail = await new BitIssueCli({
      runCommand: none.run,
      realpath: async (path) => path,
    }).getDetail("/repo", "none");
    expect(noCommentDetail.comments).toEqual({ status: "none" });

    const truncated = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("long"))),
      result("partial comment", { exitCode: 1, stdoutTruncated: true }),
    ]);
    const truncatedDetail = await new BitIssueCli({
      runCommand: truncated.run,
      realpath: async (path) => path,
    }).getDetail("/repo", "long");
    const truncatedComments = truncatedDetail.comments;
    expect(truncatedComments).toMatchObject({
      status: "ready",
      truncated: true,
    });
    expect(JSON.stringify(truncatedComments)).toContain("comments truncated");

    const failed = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("failed"))),
      result("", { exitCode: 2, stderr: Buffer.from("comments unavailable") }),
    ]);
    const failedDetail = await new BitIssueCli({
      runCommand: failed.run,
      realpath: async (path) => path,
    }).getDetail("/repo", "failed");
    expect(failedDetail.comments).toEqual({
      status: "error",
      message: "bit issue comments failed: comments unavailable",
    });
  });

  test("rejects mismatched detail ids and invalid UTF-8 comments", async () => {
    const mismatch = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("other-id"))),
    ]);
    await expect(
      new BitIssueCli({
        runCommand: mismatch.run,
        realpath: async (path) => path,
      }).getDetail("/repo", "requested-id"),
    ).rejects.toMatchObject({ kind: "invalid-data" });
    expect(mismatch.calls).toHaveLength(2);

    const invalidComment = queuedRunner([
      result("/repo/.git\n"),
      result(JSON.stringify(rawIssue("invalid-comment"))),
      result("", { stdout: Buffer.from([0xff]) }),
    ]);
    const detail = await new BitIssueCli({
      runCommand: invalidComment.run,
      realpath: async (path) => path,
    }).getDetail("/repo", "invalid-comment");
    expect(detail.comments).toMatchObject({
      status: "error",
      message: "bit issue comment output is not valid UTF-8",
    });
  });

  test("classifies missing bit, non-git directories, and malformed JSON", async () => {
    const missingRunner: RunBoundedCommand = async (command) => {
      if (command === "git") return result("/repo/.git\n");
      throw new BoundedCommandError("missing", "bit", "bit missing");
    };
    await expect(
      new BitIssueCli({
        runCommand: missingRunner,
        realpath: async (path) => path,
      }).listOpen("/repo"),
    ).rejects.toMatchObject({ kind: "missing-bit" });

    const nonGit = queuedRunner([
      result("", {
        exitCode: 128,
        stderr: Buffer.from("not a git repository"),
      }),
    ]);
    await expect(
      new BitIssueCli({ runCommand: nonGit.run }).listOpen("/tmp"),
    ).rejects.toMatchObject({
      kind: "non-git",
    });

    const malformed = queuedRunner([result("/repo/.git\n"), result("{broken")]);
    await expect(
      new BitIssueCli({
        runCommand: malformed.run,
        realpath: async (path) => path,
      }).listOpen("/repo"),
    ).rejects.toMatchObject({ kind: "invalid-data" });
  });
});

describe("bounded bit process runner", () => {
  const options = (
    overrides: Partial<BoundedCommandOptions> = {},
  ): BoundedCommandOptions => ({
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 1_000,
    stdoutMaxBytes: 1024,
    stderrMaxBytes: 1024,
    ...overrides,
  });

  test("enforces stdout byte caps", async () => {
    await expect(
      runBoundedCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(4096))"],
        options({ stdoutMaxBytes: 64 }),
      ),
    ).rejects.toMatchObject({ kind: "oversize" });
  });

  test("supports bounded raw truncation", async () => {
    const output = await runBoundedCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      options({ stdoutMaxBytes: 64, allowStdoutTruncation: true }),
    );
    expect(output.stdout.byteLength).toBe(64);
    expect(output.stdoutTruncated).toBe(true);
  });

  test("enforces timeout and AbortSignal", async () => {
    await expect(
      runBoundedCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        options({ timeoutMs: 10 }),
      ),
    ).rejects.toMatchObject({ kind: "timeout" });

    const controller = new AbortController() as unknown as {
      readonly signal: AbortSignal;
      abort(): void;
    };
    const pending = runBoundedCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      options({ signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("bit issue registry", () => {
  test("coalesces an in-flight request into one trailing refresh", async () => {
    const first = deferred<BitIssueListResult>();
    const trailing = deferred<BitIssueListResult>();
    let calls = 0;
    const source: BitIssueDataSource = {
      listOpen: async () => {
        calls += 1;
        return calls === 1 ? first.promise : trailing.promise;
      },
      getDetail: async (_cwd, id) => detailResult(id),
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    const initial = registry.refresh("/repo");
    const coalesced = registry.refresh("/repo");
    expect(calls).toBe(1);

    first.resolve(listResult("stale"));
    await Bun.sleep(0);
    expect(calls).toBe(2);
    expect(registry.getSnapshot().issues).toEqual([]);
    trailing.resolve(listResult("latest"));
    await Promise.all([initial, coalesced]);
    expect(registry.getSnapshot().issues[0]?.id).toBe("latest");
  });

  test("discards an old generation after a session switch", async () => {
    const old = deferred<BitIssueListResult>();
    const next = deferred<BitIssueListResult>();
    const source: BitIssueDataSource = {
      listOpen: (cwd) => (cwd === "/old" ? old.promise : next.promise),
      getDetail: async (_cwd, id) => detailResult(id),
    };
    const registry = new BitIssueRegistry({ cli: source, now: () => 50 });
    registry.beginSession("/old");
    const oldRefresh = registry.refresh("/old");
    registry.beginSession("/next");
    const nextRefresh = registry.refresh("/next");
    next.resolve(listResult("next"));
    await nextRefresh;
    old.resolve(listResult("old"));
    await oldRefresh;

    expect(registry.getSnapshot().issues.map((issue) => issue.id)).toEqual([
      "next",
    ]);
  });

  test("retains the last-known-good list when refresh fails", async () => {
    let calls = 0;
    const source: BitIssueDataSource = {
      async listOpen() {
        calls += 1;
        if (calls === 1) return listResult("kept");
        throw new BitIssueCliError("timeout", "refresh timeout");
      },
      getDetail: async (_cwd, id) => detailResult(id),
    };
    const registry = new BitIssueRegistry({ cli: source, now: () => calls });
    registry.beginSession("/repo");
    await registry.refresh("/repo");
    const failed = await registry.refresh("/repo");

    expect(failed).toMatchObject({ ok: false, kind: "timeout" });
    expect(registry.getSnapshot()).toMatchObject({
      stale: true,
      error: "refresh timeout",
    });
    expect(registry.getSnapshot().issues[0]?.id).toBe("kept");
  });

  test("does not let an older same-id detail overwrite a newer load", async () => {
    const older = deferred<BitIssueDetailResult>();
    const newer = deferred<BitIssueDetailResult>();
    let calls = 0;
    const source: BitIssueDataSource = {
      listOpen: async () => listResult("same-detail"),
      getDetail: async () => {
        calls += 1;
        return calls === 1 ? older.promise : newer.promise;
      },
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    const first = registry.loadDetail("same-detail");
    const second = registry.loadDetail("same-detail");
    const newest = detailResult("same-detail");
    newer.resolve({
      ...newest,
      issue: { ...newest.issue, body: "newest body" },
    });
    await second;
    older.resolve(detailResult("same-detail"));
    await first;

    expect(registry.getDetailState("same-detail")).toMatchObject({
      status: "ready",
      detail: { issue: { body: "newest body" } },
    });
  });

  test("keeps an open overlay detail readable across list refresh", async () => {
    let updatedAt = 20;
    const source: BitIssueDataSource = {
      listOpen: async () => {
        const base = listResult("open-detail");
        const [summary] = base.issues;
        if (summary === undefined) throw new Error("missing issue summary");
        return {
          ...base,
          issues: [{ ...summary, updatedAt }],
        };
      },
      getDetail: async (_cwd, id) => detailResult(id),
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    await registry.refresh("/repo");
    await registry.loadDetail("open-detail");
    updatedAt = 21;
    await registry.refresh("/repo");

    expect(registry.getDetailState("open-detail")).toMatchObject({
      status: "ready",
      detail: { issue: { body: "Body open-detail" } },
    });
  });

  test("loads comments lazily and removes an issue proven closed", async () => {
    const source: BitIssueDataSource = {
      listOpen: async () => listResult("closing"),
      getDetail: async (_cwd, id) => detailResult(id, "closed"),
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    await registry.refresh("/repo");
    expect(registry.getDetailState("closing")).toEqual({ status: "idle" });

    const pending = registry.loadDetail("closing");
    expect(registry.getDetailState("closing")).toEqual({ status: "loading" });
    await pending;
    expect(registry.getDetailState("closing")).toMatchObject({
      status: "ready",
      detail: { issue: { state: "closed" } },
    });
    expect(registry.getSnapshot().issues).toEqual([]);
  });
});
