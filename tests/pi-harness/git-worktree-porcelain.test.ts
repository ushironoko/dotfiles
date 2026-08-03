import { describe, expect, test } from "bun:test";
import {
  MAX_GIT_WORKTREE_PORCELAIN_BYTES,
  MAX_GIT_WORKTREE_RECORDS,
  MAX_GIT_WORKTREE_PATH_BYTES,
  parseGitWorktreePorcelain,
} from "../../pi/extensions/pi-harness/lib/git-worktree-porcelain";

const output = (...records: readonly (readonly string[])[]): Buffer =>
  Buffer.from(
    `${records.flatMap((fields) => [...fields, ""]).join("\0")}\0`,
    "utf8",
  );

describe("parseGitWorktreePorcelain", () => {
  test("parses branch, detached, locked, bare, and prunable records", () => {
    expect(
      parseGitWorktreePorcelain(
        output(
          [
            "worktree /repo",
            "HEAD a",
            "branch refs/heads/main",
            "locked maintenance",
          ],
          ["worktree /linked", "HEAD b", "detached"],
          ["worktree /repo.git", "bare"],
          ["worktree /stale", "HEAD c", "prunable missing gitdir"],
        ),
      ),
    ).toEqual([
      { path: "/repo", bare: false, prunable: false },
      { path: "/linked", bare: false, prunable: false },
      { path: "/repo.git", bare: true, prunable: false },
      { path: "/stale", bare: false, prunable: true },
    ]);
  });

  test.each([
    ["empty output", Buffer.alloc(0)],
    ["missing final NUL", Buffer.from("worktree /repo")],
    ["missing record separator", Buffer.from("worktree /repo\0")],
    [
      "invalid UTF-8",
      Buffer.concat([
        Buffer.from("worktree /repo/"),
        Buffer.from([255]),
        Buffer.from("\0\0"),
      ]),
    ],
    ["relative path", output(["worktree relative", "HEAD a"])],
    ["control character", output(["worktree /bad\npath", "HEAD a"])],
    [
      "worktree field after another field",
      output(["HEAD a", "worktree /repo"]),
    ],
    [
      "multiple worktree fields",
      output(["worktree /repo", "worktree /other", "HEAD a"]),
    ],
    ["unknown field", output(["worktree /repo", "future value"])],
    ["duplicate field kind", output(["worktree /repo", "HEAD a", "HEAD b"])],
    [
      "branch and detached",
      output(["worktree /repo", "branch refs/heads/main", "detached"]),
    ],
    [
      "duplicate path",
      output(["worktree /repo", "HEAD a"], ["worktree /repo", "HEAD b"]),
    ],
  ])("rejects malformed input: %s", (_label, stdout) => {
    expect(parseGitWorktreePorcelain(stdout)).toBeUndefined();
  });

  test("rejects inputs above each security bound", () => {
    expect(
      parseGitWorktreePorcelain(
        Buffer.alloc(MAX_GIT_WORKTREE_PORCELAIN_BYTES + 1, 0x61),
      ),
    ).toBeUndefined();
    expect(
      parseGitWorktreePorcelain(
        output([`worktree /${"a".repeat(MAX_GIT_WORKTREE_PATH_BYTES)}`]),
      ),
    ).toBeUndefined();
    expect(
      parseGitWorktreePorcelain(
        output(
          ...Array.from(
            { length: MAX_GIT_WORKTREE_RECORDS + 1 },
            (_, index) => [`worktree /repo-${index}`, `HEAD ${index}`],
          ),
        ),
      ),
    ).toBeUndefined();
  });
});
