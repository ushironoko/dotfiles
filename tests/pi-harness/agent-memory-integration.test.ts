import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentMemoryCli } from "../../pi/extensions/pi-harness/features/agent-memory/cli";
import { MEMORY_REF_PREFIX } from "../../pi/extensions/pi-harness/features/agent-memory/model";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const run = async (cwd: string, command: string, args: string[]) => {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
};

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent memory real bit-notes integration", () => {
  test("aggregates isolated writers across a linked worktree and honors tombstones", async () => {
    if (Bun.which("bit") === null) {
      throw new Error(
        "bit is required for the project-memory integration test",
      );
    }
    const root = await mkdtemp(join(tmpdir(), "pi-agent-memory-"));
    roots.push(root);
    const main = join(root, "main");
    const linked = join(root, "linked");
    await git(root, "init", main);
    await git(main, "config", "user.name", "Memory Test");
    await git(main, "config", "user.email", "memory@example.invalid");
    await writeFile(join(main, "README.md"), "fixture\n", "utf8");
    await git(main, "add", "README.md");
    await git(main, "commit", "-m", "fixture");
    await git(main, "worktree", "add", "-b", "memory-linked", linked);

    const trust = { trustedRoots: [main] };
    const first = new AgentMemoryCli({ writerKey: "a".repeat(64) });
    const second = new AgentMemoryCli({ writerKey: "b".repeat(64) });

    const architecture = await first.update(main, trust, "physical-session", {
      action: "put",
      path: "project/architecture.md",
      description: "The durable architecture choice",
      content: "The notes backend uses aggregate reads.",
    });
    expect(architecture.status).toBe("written");

    const correction = await second.update(linked, trust, "physical-session", {
      action: "put",
      path: "feedback/notes-not-memory.md",
      description: "Use bit notes rather than bit memory",
      content: "The user explicitly selected session-scoped notes.",
    });
    expect(correction.status).toBe("written");

    const conflictNow = Date.now();
    const third = new AgentMemoryCli({
      writerKey: "d".repeat(64),
      now: () => conflictNow,
    });
    const fourth = new AgentMemoryCli({
      writerKey: "e".repeat(64),
      now: () => conflictNow,
    });
    const [thirdWrite, fourthWrite] = await Promise.all([
      third.update(main, trust, "physical-session", {
        action: "put",
        path: "project/concurrent.md",
        description: "Concurrent writer D",
        content: "Lower source-ref tie breaker.",
      }),
      fourth.update(linked, trust, "physical-session", {
        action: "put",
        path: "project/concurrent.md",
        description: "Concurrent writer E",
        content: "Higher source-ref tie breaker.",
      }),
    ]);
    expect(thirdWrite.status).toBe("written");
    expect(fourthWrite.status).toBe("written");

    const aggregate = await new AgentMemoryCli({
      writerKey: "c".repeat(64),
    }).aggregate(linked, trust);
    expect(aggregate.repository.trustSource).toBe("linked-worktree");
    expect([...aggregate.merged.entries.keys()].sort()).toEqual([
      "feedback/notes-not-memory.md",
      "project/architecture.md",
      "project/concurrent.md",
    ]);
    expect(
      aggregate.merged.entries.get("project/concurrent.md")?.record.content,
    ).toBe("Higher source-ref tie breaker.");
    expect(aggregate.refs).toHaveLength(4);

    expect(
      await second.update(linked, trust, "physical-session", {
        action: "put",
        path: "feedback/notes-not-memory.md",
        description: "Use bit notes rather than bit memory",
        content: "The user explicitly selected session-scoped notes.",
      }),
    ).toEqual({ status: "unchanged", path: "feedback/notes-not-memory.md" });

    const removed = await first.update(main, trust, "physical-session", {
      action: "remove",
      path: "project/architecture.md",
    });
    expect(removed).toMatchObject({ status: "written", deleted: true });

    const afterRemove = await second.aggregate(main, trust);
    expect(afterRemove.merged.entries.has("project/architecture.md")).toBe(
      false,
    );
    expect(afterRemove.merged.deleted.has("project/architecture.md")).toBe(
      true,
    );

    const refs = await git(
      main,
      "for-each-ref",
      "--format=%(refname)",
      MEMORY_REF_PREFIX,
    );
    expect(refs.trim().split(/\r?\n/)).toHaveLength(4);
  });
});
