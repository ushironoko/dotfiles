import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { planSweep, runSweep } from "../../../src/core/logproxy/sweep";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = 1_000 * DAY; // 固定の「現在」

const opts = { keepDays: 14, gzipIdleMinutes: 30 };

describe("planSweep（純粋）", () => {
  it("idle な .jsonl は gzip 対象、直近の .jsonl は対象外", () => {
    const plan = planSweep(
      [
        { name: "idle.jsonl", mtimeMs: NOW - 40 * MIN },
        { name: "fresh.jsonl", mtimeMs: NOW - 5 * MIN },
      ],
      NOW,
      opts,
    );
    expect(plan.toGzip).toEqual(["idle.jsonl"]);
    expect(plan.toDelete).toEqual([]);
  });

  it("keepDays 超過の .jsonl は delete（gzip より prune 優先）", () => {
    const plan = planSweep(
      [{ name: "old.jsonl", mtimeMs: NOW - 15 * DAY }],
      NOW,
      opts,
    );
    expect(plan.toDelete).toEqual(["old.jsonl"]);
    expect(plan.toGzip).toEqual([]);
  });

  it("keepDays 超過の .jsonl.gz も delete", () => {
    const plan = planSweep(
      [{ name: "s.123.jsonl.gz", mtimeMs: NOW - 20 * DAY }],
      NOW,
      opts,
    );
    expect(plan.toDelete).toEqual(["s.123.jsonl.gz"]);
  });

  it("境界: ちょうど keepDays は残す / わずかに超えたら削除", () => {
    const exact = planSweep(
      [{ name: "a.jsonl", mtimeMs: NOW - 14 * DAY }],
      NOW,
      opts,
    );
    const over = planSweep(
      [{ name: "a.jsonl", mtimeMs: NOW - 14 * DAY - 1 }],
      NOW,
      opts,
    );
    expect(exact.toDelete).toEqual([]);
    expect(over.toDelete).toEqual(["a.jsonl"]);
  });

  it("アクティブなセッションは gzip しない", () => {
    const plan = planSweep(
      [{ name: "live.jsonl", mtimeMs: NOW - 40 * MIN }],
      NOW,
      { ...opts, activeSessions: new Set(["live"]) },
    );
    expect(plan.toGzip).toEqual([]);
  });

  it("直近の .jsonl.gz は何もしない（再gzipしない）", () => {
    const plan = planSweep(
      [{ name: "s.1.jsonl.gz", mtimeMs: NOW - 40 * MIN }],
      NOW,
      opts,
    );
    expect(plan.toGzip).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});

describe("runSweep（executor, 実FS）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupTestDirectory("logproxy-sweep");
  });
  afterEach(async () => {
    await cleanupTestDirectory(dir);
  });

  const setMtime = async (name: string, mtimeMs: number) => {
    const p = join(dir, name);
    await fs.utimes(p, mtimeMs / 1000, mtimeMs / 1000);
  };

  it("idle な .jsonl を segment gzip 化し、元 .jsonl を消す（往復でバイト一致）", async () => {
    const original = '{"a":1}\n{"a":2}\n';
    await fs.writeFile(join(dir, "sess.jsonl"), original);
    await setMtime("sess.jsonl", NOW - 40 * MIN);

    await runSweep({ dir, now: NOW, ...opts });

    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e === "sess.jsonl")).toBe(false);
    const gz = entries.find(
      (e) => e.startsWith("sess.") && e.endsWith(".jsonl.gz"),
    );
    expect(gz).toBeTruthy();
    const restored = Buffer.from(
      Bun.gunzipSync(new Uint8Array(await fs.readFile(join(dir, gz!)))),
    ).toString();
    expect(restored).toBe(original);
  });

  it("keepDays 超過の .jsonl と .jsonl.gz を削除する", async () => {
    await fs.writeFile(join(dir, "old.jsonl"), "x\n");
    await fs.writeFile(
      join(dir, "old.1.jsonl.gz"),
      Bun.gzipSync(Buffer.from("y")),
    );
    await setMtime("old.jsonl", NOW - 30 * DAY);
    await setMtime("old.1.jsonl.gz", NOW - 30 * DAY);

    await runSweep({ dir, now: NOW, ...opts });

    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  it("アクティブなセッションの idle .jsonl は gzip しない", async () => {
    await fs.writeFile(join(dir, "live.jsonl"), "z\n");
    await setMtime("live.jsonl", NOW - 40 * MIN);

    await runSweep({
      dir,
      now: NOW,
      ...opts,
      activeSessions: new Set(["live"]),
    });

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["live.jsonl"]);
  });
});
