import { isAbsolute } from "node:path";

export const MAX_GIT_WORKTREE_PORCELAIN_BYTES = 64 * 1_024;
export const MAX_GIT_WORKTREE_RECORDS = 128;
export const MAX_GIT_WORKTREE_PATH_BYTES = 1_024;

const decoder = new TextDecoder(undefined, {
  fatal: true,
  ignoreBOM: true,
});
const allowedFieldKinds = new Set([
  "HEAD",
  "branch",
  "detached",
  "bare",
  "locked",
  "prunable",
]);

export interface GitWorktreePorcelainRecord {
  readonly path: string;
  readonly bare: boolean;
  readonly prunable: boolean;
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

/**
 * Parses the NUL-delimited output of `git worktree list --porcelain -z`.
 *
 * This parser is intentionally bounded and fail-closed because its output is
 * used for repository boundary decisions. Filesystem canonicalization and
 * caller-specific bare/prunable filtering happen after this structural pass.
 */
export const parseGitWorktreePorcelain = (
  stdout: Uint8Array,
): readonly GitWorktreePorcelainRecord[] | undefined => {
  if (
    stdout.byteLength === 0 ||
    stdout.byteLength > MAX_GIT_WORKTREE_PORCELAIN_BYTES
  ) {
    return undefined;
  }

  let text: string;
  try {
    text = decoder.decode(stdout);
  } catch {
    return undefined;
  }
  if (!text.endsWith("\0\0")) return undefined;

  const records: GitWorktreePorcelainRecord[] = [];
  const seenPaths = new Set<string>();
  let fields: string[] = [];
  const consume = (): boolean => {
    if (fields.length === 0) return true;

    const [firstField] = fields;
    const worktreeFields = fields.filter((field) =>
      field.startsWith("worktree "),
    );
    const [worktreeField] = worktreeFields;
    if (
      firstField === undefined ||
      worktreeField === undefined ||
      worktreeFields.length !== 1 ||
      worktreeField !== firstField
    ) {
      return false;
    }

    const path = worktreeField.slice("worktree ".length);
    if (
      path === "" ||
      !isAbsolute(path) ||
      Buffer.byteLength(path, "utf8") > MAX_GIT_WORKTREE_PATH_BYTES ||
      hasControlCharacter(path) ||
      seenPaths.has(path)
    ) {
      return false;
    }
    seenPaths.add(path);

    const seenKinds = new Set<string>();
    for (const field of fields.slice(1)) {
      const [kind] = field.split(" ", 1);
      if (
        kind === undefined ||
        !allowedFieldKinds.has(kind) ||
        seenKinds.has(kind)
      ) {
        return false;
      }
      seenKinds.add(kind);
    }
    if (seenKinds.has("branch") && seenKinds.has("detached")) return false;

    records.push({
      path,
      bare: seenKinds.has("bare"),
      prunable: seenKinds.has("prunable"),
    });
    return records.length <= MAX_GIT_WORKTREE_RECORDS;
  };

  for (const field of text.split("\0")) {
    if (field !== "") {
      fields.push(field);
      continue;
    }
    if (!consume()) return undefined;
    fields = [];
  }
  if (fields.length !== 0 || records.length === 0) return undefined;
  return records;
};
