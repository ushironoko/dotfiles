import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionJudgeConfig } from "../../pi/extensions/pi-harness/config";
import {
  createPermissionJudgeRuntime,
  inspectPermissionJudgeExecutable,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge-runtime";

const roots: string[] = [];

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "judge-runtime-")));
  roots.push(root);
  const executablePath = join(root, "codex");
  const executableBytes = "trusted-codex-fixture";
  writeFileSync(executablePath, executableBytes, { mode: 0o500 });
  chmodSync(executablePath, 0o500);
  const config: PermissionJudgeConfig = {
    enabled: true,
    executablePath,
    expectedExecutableSha256: createHash("sha256")
      .update(executableBytes)
      .digest("hex"),
    model: "gpt-5.6-luna",
    timeoutMs: 30_000,
    confirmTimeoutMs: 10_000,
  };
  return { root, executablePath, executableBytes, config };
};

const auth = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "account",
  },
  last_refresh: "2026-01-01T00:00:00Z",
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("permission judge trusted runtime", () => {
  test("pins canonical executable bytes and detects later mutation", () => {
    const { root, executablePath, config } = fixture();
    const runtime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "runtime"),
    });

    expect(runtime.identity.executablePath).toBe(executablePath);
    expect(runtime.verify().fingerprint).toBe(runtime.identity.fingerprint);

    chmodSync(executablePath, 0o700);
    writeFileSync(executablePath, "modified-codex-fixture");
    chmodSync(executablePath, 0o500);
    expect(() => runtime.verify()).toThrow();
  });

  test("rejects digest mismatch, symlinks, hardlinks, and writable identities", () => {
    const { root, executablePath, config } = fixture();
    expect(() =>
      inspectPermissionJudgeExecutable({
        ...config,
        expectedExecutableSha256: "0".repeat(64),
      }),
    ).toThrow();

    const symlinkPath = join(root, "codex-link");
    symlinkSync(executablePath, symlinkPath);
    expect(() =>
      inspectPermissionJudgeExecutable({
        ...config,
        executablePath: symlinkPath,
      }),
    ).toThrow();

    const hardlinkPath = join(root, "codex-hardlink");
    linkSync(executablePath, hardlinkPath);
    expect(() => inspectPermissionJudgeExecutable(config)).toThrow();
    rmSync(hardlinkPath);

    chmodSync(executablePath, 0o522);
    expect(() => inspectPermissionJudgeExecutable(config)).toThrow();
  });

  test("rejects writable executable ancestors and non-private runtime roots", () => {
    const { root, executableBytes, config } = fixture();
    const writableParent = join(root, "writable");
    mkdirSync(writableParent, { mode: 0o700 });
    const nestedExecutable = join(writableParent, "codex");
    writeFileSync(nestedExecutable, executableBytes, { mode: 0o500 });
    chmodSync(writableParent, 0o777);
    expect(() =>
      inspectPermissionJudgeExecutable({
        ...config,
        executablePath: nestedExecutable,
      }),
    ).toThrow();

    const runtimeRoot = join(root, "runtime");
    mkdirSync(runtimeRoot, { mode: 0o755 });
    chmodSync(runtimeRoot, 0o755);
    expect(() =>
      createPermissionJudgeRuntime(config, { runtimeRoot }),
    ).toThrow();
  });

  test("creates an auth-only environment with no inherited control variables", () => {
    const { root, config } = fixture();
    const authFile = join(root, "auth.json");
    writeFileSync(authFile, auth, { mode: 0o600 });
    chmodSync(authFile, 0o600);
    const runtime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "runtime"),
      authFile,
    });
    const workspace = runtime.createWorkspace(
      "instructions",
      "schema",
      "model catalog",
      "hostile sentinel",
    );
    try {
      expect(workspace.environment).toEqual({
        HOME: workspace.home,
        CODEX_HOME: workspace.codexHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PWD: workspace.cwd,
        TERM: "dumb",
        TMPDIR: join(dirname(workspace.cwd), "tmp"),
      });
      expect(readFileSync(join(workspace.codexHome, "auth.json"), "utf8")).toBe(
        auth,
      );
      expect(readFileSync(join(workspace.cwd, "AGENTS.md"), "utf8")).toBe(
        "hostile sentinel",
      );
      expect(readFileSync(workspace.modelCatalogFile, "utf8")).toBe(
        "model catalog",
      );
      expect(() => statSync(join(workspace.codexHome, "AGENTS.md"))).toThrow();
      expect(statSync(workspace.cwd).mode & 0o777).toBe(0o700);
      expect(statSync(workspace.home).mode & 0o777).toBe(0o700);
      expect(statSync(workspace.codexHome).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(workspace.codexHome, "auth.json")).mode & 0o777,
      ).toBe(0o600);
      expect(statSync(workspace.modelCatalogFile).mode & 0o777).toBe(0o600);
      expect(dirname(workspace.deniedImageFile)).toBe(dirname(workspace.cwd));
      expect(statSync(workspace.deniedImageFile).mode & 0o777).toBe(0o600);
      expect(
        readFileSync(workspace.deniedImageFile).subarray(1, 4).toString(),
      ).toBe("PNG");
      expect(workspace.environment.HTTP_PROXY).toBeUndefined();
      expect(workspace.environment.SSL_CERT_FILE).toBeUndefined();
      expect(workspace.environment.NODE_OPTIONS).toBeUndefined();
      expect(workspace.environment.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      workspace.cleanup();
    }
    expect(() => statSync(workspace.cwd)).toThrow();
  });

  test("rejects non-private, non-canonical, and non-auth credential input", () => {
    const { root, config } = fixture();
    const privateAuth = join(root, "auth.json");
    writeFileSync(privateAuth, auth, { mode: 0o600 });
    chmodSync(privateAuth, 0o600);

    const linkedAuth = join(root, "auth-link.json");
    symlinkSync(privateAuth, linkedAuth);
    const linkedRuntime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "linked-runtime"),
      authFile: linkedAuth,
    });
    expect(() =>
      linkedRuntime.createWorkspace("instructions", "schema", "catalog"),
    ).toThrow();

    chmodSync(privateAuth, 0o644);
    const publicRuntime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "public-runtime"),
      authFile: privateAuth,
    });
    expect(() =>
      publicRuntime.createWorkspace("instructions", "schema", "catalog"),
    ).toThrow();

    chmodSync(privateAuth, 0o600);
    writeFileSync(
      privateAuth,
      JSON.stringify({ ...JSON.parse(auth), model_provider: "hostile" }),
    );
    const extendedRuntime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "extended-runtime"),
      authFile: privateAuth,
    });
    expect(() =>
      extendedRuntime.createWorkspace("instructions", "schema", "catalog"),
    ).toThrow();
  });

  test("rejects a runtime root inside any registered worktree", () => {
    const { root, config } = fixture();
    const runtime = createPermissionJudgeRuntime(config, {
      runtimeRoot: join(root, "runtime"),
    });
    expect(() => runtime.assertOutsideWorktrees([root])).toThrow();
    expect(() =>
      runtime.assertOutsideWorktrees([join(root, "unrelated")]),
    ).not.toThrow();
  });
});
