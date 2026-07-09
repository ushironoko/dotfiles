import { describe, it, expect } from "bun:test";
import { runInstall, runUninstall } from "../../../src/core/logproxy/install";

const makeDeps = (overrides: Record<string, unknown>, calls: string[]) => ({
  writePlist: async () => {
    calls.push("writePlist");
    return "/plist";
  },
  bootstrap: async () => {
    calls.push("bootstrap");
  },
  pollHealth: async () => {
    calls.push("pollHealth");
    return true;
  },
  writeEnv: async () => {
    calls.push("writeEnv");
  },
  rollback: async () => {
    calls.push("rollback");
  },
  ...overrides,
});

describe("runInstall — health-gate 不変条件", () => {
  it("成功時: writePlist→bootstrap→pollHealth→writeEnv の順、rollback しない", async () => {
    const calls: string[] = [];
    const r = await runInstall(makeDeps({}, calls));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      "writePlist",
      "bootstrap",
      "pollHealth",
      "writeEnv",
    ]);
  });

  it("health 失敗時: writeEnv を絶対に呼ばず rollback する", async () => {
    const calls: string[] = [];
    const r = await runInstall(
      makeDeps(
        {
          pollHealth: async () => {
            calls.push("pollHealth");
            return false;
          },
        },
        calls,
      ),
    );
    expect(r.ok).toBe(false);
    expect(calls).not.toContain("writeEnv");
    expect(calls).toContain("rollback");
  });

  it("bootstrap 失敗時: pollHealth も writeEnv も呼ばず rollback する", async () => {
    const calls: string[] = [];
    const r = await runInstall(
      makeDeps(
        {
          bootstrap: async () => {
            calls.push("bootstrap");
            throw new Error("bootstrap failed");
          },
        },
        calls,
      ),
    );
    expect(r.ok).toBe(false);
    expect(calls).not.toContain("pollHealth");
    expect(calls).not.toContain("writeEnv");
    expect(calls).toContain("rollback");
  });
});

describe("runUninstall — 逆順（先に env 削除）", () => {
  it("removeEnv→bootout→removePlist の順", async () => {
    const calls: string[] = [];
    await runUninstall({
      removeEnv: async () => {
        calls.push("removeEnv");
      },
      bootout: async () => {
        calls.push("bootout");
      },
      removePlist: async () => {
        calls.push("removePlist");
      },
    });
    expect(calls).toEqual(["removeEnv", "bootout", "removePlist"]);
  });
});
