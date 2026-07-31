import { describe, expect, test } from "bun:test";
import {
  decodeMemoryRecord,
  gitBlobOid,
  memoryTargetBytes,
  memoryWriterRef,
  mergeMemoryRecords,
  nextMemoryTimestamp,
  parseManagedMemoryRef,
  serializeMemoryRecord,
  type MemoryRecord,
  type SourcedMemoryRecord,
} from "../../pi/extensions/pi-harness/features/agent-memory/model";

const NOW = Date.parse("2026-07-31T08:00:00.000Z");

const record = (
  path: string,
  updatedAt: string,
  deleted = false,
): MemoryRecord => ({
  version: 1,
  path,
  description: deleted ? "" : `Description for ${path}`,
  updatedAt,
  deleted,
  content: deleted ? "" : `Content for ${path}`,
});

const sourced = (
  value: MemoryRecord,
  sourceRef: string,
): SourcedMemoryRecord => ({
  record: value,
  sourceRef,
  targetOid: gitBlobOid(memoryTargetBytes(value.path), "sha1"),
});

describe("agent memory record model", () => {
  test("pins target bytes and supports SHA-1/SHA-256 repositories", () => {
    const bytes = memoryTargetBytes("project/architecture.md");
    expect(bytes.toString("utf8")).toBe(
      "pi-agent-memory-target-v1\0project/architecture.md\n",
    );
    expect(gitBlobOid(bytes, "sha1")).toMatch(/^[0-9a-f]{40}$/);
    expect(gitBlobOid(bytes, "sha256")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("validates logical paths, exact record shape, controls, and clock window", () => {
    expect(() => memoryTargetBytes("project/ok.md")).not.toThrow();
    for (const invalid of [
      "other/no.md",
      "project/../secret.md",
      "project/nested/path.md",
      "project/UPPER.md",
      "project/no-extension",
    ]) {
      expect(() => memoryTargetBytes(invalid)).toThrow();
    }

    expect(
      decodeMemoryRecord(
        record("feedback/user-correction.md", "2026-07-31T08:00:01.000Z"),
        NOW,
      ).path,
    ).toBe("feedback/user-correction.md");
    expect(() =>
      decodeMemoryRecord(
        record("project/future.md", "2026-07-31T08:05:00.001Z"),
        NOW,
      ),
    ).toThrow("timestamp");
    expect(() =>
      decodeMemoryRecord(
        {
          ...record("project/control.md", "2026-07-31T08:00:00.000Z"),
          description: "spoof\u001b[2J",
        },
        NOW,
      ),
    ).toThrow("description");
    expect(() =>
      decodeMemoryRecord(
        {
          ...record("project/extra.md", "2026-07-31T08:00:00.000Z"),
          extra: true,
        },
        NOW,
      ),
    ).toThrow("shape");
  });

  test("serializes every valid maximum-size record within the object cap", () => {
    const maximal = decodeMemoryRecord(
      {
        version: 1,
        path: "project/maximal.md",
        description: '"'.repeat(512),
        updatedAt: "2026-07-31T08:00:00.000Z",
        deleted: false,
        content: '"'.repeat(32 * 1024),
      },
      NOW,
    );

    const serialized = serializeMemoryRecord(maximal);
    expect(serialized.byteLength).toBeLessThanOrEqual(70 * 1024);
    expect(
      decodeMemoryRecord(JSON.parse(serialized.toString("utf8")), NOW).content,
    ).toBe(maximal.content);
  });

  test("merges newest values, lets tombstones win, and ties by source ref", () => {
    const path = "project/decision.md";
    const older = sourced(
      record(path, "2026-07-31T07:59:00.000Z"),
      "refs/notes/pi-agent-memory/sessions/a/writers/a",
    );
    const newerDelete = sourced(
      record(path, "2026-07-31T08:00:00.000Z", true),
      "refs/notes/pi-agent-memory/sessions/b/writers/b",
    );
    const mergedDelete = mergeMemoryRecords([older, newerDelete]);
    expect(mergedDelete.entries.has(path)).toBe(false);
    expect(mergedDelete.deleted.get(path)).toBe(newerDelete);

    const tiedLow = sourced(
      record(path, "2026-07-31T08:00:00.000Z"),
      "refs/notes/pi-agent-memory/sessions/a/writers/a",
    );
    const tiedHigh = sourced(
      record(path, "2026-07-31T08:00:00.000Z"),
      "refs/notes/pi-agent-memory/sessions/z/writers/z",
    );
    expect(mergeMemoryRecords([tiedHigh, tiedLow]).entries.get(path)).toBe(
      tiedHigh,
    );
  });

  test("derives managed writer refs and advances explicit correction timestamps", () => {
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    const ref = memoryWriterRef(keyA, keyB);
    expect(parseManagedMemoryRef(ref)).toEqual({
      ref,
      sessionKey: keyA,
      writerKey: keyB,
    });
    expect(parseManagedMemoryRef(`${ref}/extra`)).toBeUndefined();

    const latest = sourced(
      record("reference/api.md", "2026-07-31T08:04:00.000Z"),
      ref,
    );
    expect(nextMemoryTimestamp(latest, NOW)).toBe("2026-07-31T08:04:00.001Z");
  });
});
