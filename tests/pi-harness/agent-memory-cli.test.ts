import { describe, expect, test } from "bun:test";
import {
  AgentMemoryCli,
  AgentMemoryCliError,
} from "../../pi/extensions/pi-harness/features/agent-memory/cli";
import {
  gitBlobOid,
  makeMemoryRecord,
  MEMORY_OBJECT_LIMIT,
  MEMORY_RECORD_MAX_BYTES,
  MEMORY_REF_PREFIX,
  memoryTargetBytes,
  serializeMemoryRecord,
} from "../../pi/extensions/pi-harness/features/agent-memory/model";
import {
  BoundedCommandError,
  type BoundedCommandOptions,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../pi/extensions/pi-harness/lib/bounded-process";

const result = (stdout = "", stderr = ""): BoundedCommandResult => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
  stdoutTruncated: false,
});

interface Call {
  command: string;
  args: readonly string[];
  options: BoundedCommandOptions;
}

const queued = (responses: (BoundedCommandResult | Error)[]) => {
  const calls: Call[] = [];
  const run: RunBoundedCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    if (next === undefined) throw new Error("missing fake command response");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, run };
};

const identity = result("/repo\n/repo/.git\nsha1\n");
const trustedRoot = result("/repo/.git\n");
const empty = result();

describe("agent memory CLI contract", () => {
  test("uses exact shell-free Git stdin and the current bit notes -m argv contract", async () => {
    const path = "project/command-contract.md";
    const expectedTarget = gitBlobOid(memoryTargetBytes(path), "sha1");
    const fake = queued([
      identity,
      trustedRoot,
      empty, // bit notes read capability
      empty, // git cat-file batch-check
      empty, // managed refs
      result(`${expectedTarget}\n`), // git hash-object write
      empty, // bit notes write
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      now: () => Date.parse("2026-07-31T08:00:00.000Z"),
      writerKey: "b".repeat(64),
      env: { PATH: process.env.PATH },
    });
    const content = "Literal $(touch nope) and `echo nope` remain data.";

    const update = await cli.update(
      "/repo",
      { trustedRoots: ["/repo"] },
      "physical-session",
      {
        action: "put",
        path,
        description: "Pin the direct argv contract",
        content,
      },
    );
    expect(update.status).toBe("written");

    const hashCall = fake.calls.at(-2);
    expect(hashCall?.command).toBe("git");
    expect(hashCall?.args).toEqual(["hash-object", "-w", "--stdin"]);
    expect(Buffer.from(hashCall?.options.stdin ?? []).toString("utf8")).toBe(
      memoryTargetBytes(path).toString("utf8"),
    );

    const notesCall = fake.calls.at(-1);
    expect(notesCall?.command).toBe("bit");
    expect(notesCall?.options.stdin).toBeUndefined();
    expect(notesCall?.args.slice(0, 6)).toEqual([
      "notes",
      expect.stringMatching(
        /^--ref=refs\/notes\/pi-agent-memory\/sessions\/[0-9a-f]{64}\/writers\/b{64}$/,
      ),
      "add",
      "-f",
      "-m",
      expect.any(String),
    ]);
    expect(notesCall?.args.at(-1)).toBe(expectedTarget);
    const noteBody = JSON.parse(notesCall?.args[5] ?? "") as {
      content: string;
      path: string;
    };
    expect(noteBody).toMatchObject({ path, content });
  });

  test("isolates oversized and malformed notes while preserving valid records", async () => {
    const nowMs = Date.parse("2026-07-31T08:00:00.000Z");
    const ref = `${MEMORY_REF_PREFIX}/${"a".repeat(64)}/writers/${"b".repeat(64)}`;
    const validPath = "project/valid.md";
    const validTarget = gitBlobOid(memoryTargetBytes(validPath), "sha1");
    const oversizeTarget = gitBlobOid(
      memoryTargetBytes("project/oversize.md"),
      "sha1",
    );
    const invalidTarget = gitBlobOid(
      memoryTargetBytes("project/invalid.md"),
      "sha1",
    );
    const validNote = "1".repeat(40);
    const oversizeNote = "2".repeat(40);
    const invalidNote = "3".repeat(40);
    const validBody = serializeMemoryRecord(
      makeMemoryRecord(
        {
          path: validPath,
          description: "Valid durable memory",
          content: "This record must survive corrupt siblings.",
          deleted: false,
          updatedAt: "2026-07-31T07:59:00.000Z",
        },
        nowMs,
      ),
    ).toString("utf8");
    const invalidBody = "not-json";
    const fake = queued([
      identity,
      trustedRoot,
      empty,
      empty,
      result(`${ref}\n`),
      result(
        `${validNote} ${validTarget}\n${oversizeNote} ${oversizeTarget}\n${invalidNote} ${invalidTarget}\n`,
      ),
      result(
        `${validNote} blob ${Buffer.byteLength(validBody)}\n${oversizeNote} blob ${MEMORY_RECORD_MAX_BYTES + 1}\n${invalidNote} blob ${Buffer.byteLength(invalidBody)}\n`,
      ),
      result(
        `${validNote} blob ${Buffer.byteLength(validBody)}\n${validBody}\n${invalidNote} blob ${Buffer.byteLength(invalidBody)}\n${invalidBody}\n`,
      ),
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      now: () => nowMs,
      writerKey: "c".repeat(64),
      env: { PATH: process.env.PATH },
    });

    const aggregate = await cli.aggregate("/repo", {
      trustedRoots: ["/repo"],
    });

    expect(aggregate.truncated).toBe(false);
    expect(aggregate.merged.entries.get(validPath)?.record.content).toBe(
      "This record must survive corrupt siblings.",
    );
    expect(aggregate.diagnostics).toHaveLength(2);
    expect(aggregate.diagnostics.join("\n")).toContain("oversize");
    expect(aggregate.diagnostics.join("\n")).toContain(
      "invalid memory note ignored",
    );
    expect(fake.calls.at(-2)?.args).toEqual(["cat-file", "--batch-check"]);
    expect(fake.calls.at(-1)?.args).toEqual(["cat-file", "--batch"]);
  });

  test("bounds ref enumeration and marks invalid refs consuming the limit", async () => {
    const refs = Array.from(
      { length: 65 },
      (_, index) => `${MEMORY_REF_PREFIX}/invalid-${index}`,
    );
    const fake = queued([
      identity,
      trustedRoot,
      empty,
      empty,
      result(`${refs.join("\n")}\n`),
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      writerKey: "f".repeat(64),
      env: { PATH: process.env.PATH },
    });

    const aggregate = await cli.aggregate("/repo", {
      trustedRoots: ["/repo"],
    });

    expect(aggregate.truncated).toBe(true);
    expect(aggregate.refs).toEqual([]);
    expect(aggregate.diagnostics).toHaveLength(20);
    expect(fake.calls.at(-1)?.args).toEqual([
      "for-each-ref",
      "--count=65",
      "--format=%(refname)",
      MEMORY_REF_PREFIX,
    ]);
  });

  test("isolates an oversized note list but marks the aggregate truncated", async () => {
    const ref = `${MEMORY_REF_PREFIX}/${"a".repeat(64)}/writers/${"b".repeat(64)}`;
    const fake = queued([
      identity,
      trustedRoot,
      empty,
      empty,
      result(`${ref}\n`),
      new BoundedCommandError("oversize", "bit", "too much output"),
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      writerKey: "f".repeat(64),
      env: { PATH: process.env.PATH },
    });

    const aggregate = await cli.aggregate("/repo", {
      trustedRoots: ["/repo"],
    });

    expect(aggregate.truncated).toBe(true);
    expect(aggregate.merged.entries.size).toBe(0);
    expect(aggregate.diagnostics).toEqual([
      `${ref}: unreadable note list ignored`,
    ]);
  });

  test("marks an exact object-limit fill truncated when later refs remain", async () => {
    const nowMs = Date.parse("2026-07-31T08:00:00.000Z");
    const firstRef = `${MEMORY_REF_PREFIX}/${"a".repeat(64)}/writers/${"b".repeat(64)}`;
    const secondRef = `${MEMORY_REF_PREFIX}/${"c".repeat(64)}/writers/${"d".repeat(64)}`;
    const path = "project/boundary.md";
    const target = gitBlobOid(memoryTargetBytes(path), "sha1");
    const noteOid = "4".repeat(40);
    const body = serializeMemoryRecord(
      makeMemoryRecord(
        {
          path,
          description: "Object limit boundary",
          content: "Later refs must not be silently omitted.",
          deleted: false,
          updatedAt: "2026-07-31T07:59:00.000Z",
        },
        nowMs,
      ),
    ).toString("utf8");
    const noteList = `${Array.from(
      { length: MEMORY_OBJECT_LIMIT },
      () => `${noteOid} ${target}`,
    ).join("\n")}\n`;
    const fake = queued([
      identity,
      trustedRoot,
      empty,
      empty,
      result(`${firstRef}\n${secondRef}\n`),
      result(noteList),
      result(`${noteOid} blob ${Buffer.byteLength(body)}\n`),
      result(`${noteOid} blob ${Buffer.byteLength(body)}\n${body}\n`),
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      now: () => nowMs,
      writerKey: "e".repeat(64),
      env: { PATH: process.env.PATH },
    });

    const aggregate = await cli.aggregate("/repo", {
      trustedRoots: ["/repo"],
    });

    expect(aggregate.truncated).toBe(true);
    expect(aggregate.refs).toHaveLength(2);
    expect(
      fake.calls.filter(
        ({ command, args }) => command === "bit" && args.at(-1) === "list",
      ),
    ).toHaveLength(2); // capability probe + the saturated first ref
  });

  test("enforces one wall-clock deadline across aggregate subprocesses", async () => {
    const fake = queued([identity]);
    let clock = 0;
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      now: () => {
        clock += 3_000;
        return clock;
      },
      writerKey: "d".repeat(64),
      env: { PATH: process.env.PATH },
    });

    await expect(
      cli.aggregate("/repo", { trustedRoots: ["/repo"] }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fake.calls).toHaveLength(1);
  });

  test("classifies a missing bit probe without attempting mutation", async () => {
    const fake = queued([
      identity,
      trustedRoot,
      new BoundedCommandError("missing", "bit", "bit missing"),
    ]);
    const cli = new AgentMemoryCli({
      runCommand: fake.run,
      realpath: async (value) => value,
      writerKey: "c".repeat(64),
      env: { PATH: process.env.PATH },
    });

    try {
      await cli.aggregate("/repo", { trustedRoots: ["/repo"] });
      throw new Error("expected missing bit");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMemoryCliError);
      expect(error).toMatchObject({ kind: "missing-bit" });
    }
    expect(fake.calls.map(({ command }) => command)).toEqual([
      "git",
      "git",
      "bit",
    ]);
  });
});
