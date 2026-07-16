import { describe, test, expect, afterEach } from "bun:test";
import { promises as fs, constants } from "node:fs";
import { join, resolve } from "node:path";
import { setupTestDirectory, cleanupTestDirectory } from "../test-helpers";

const COPY_CAPTURE = resolve(
  import.meta.dir,
  "../../config/zellij/copy-capture.sh",
);
const TRANSLATE_POPUP = resolve(
  import.meta.dir,
  "../../config/zellij/translate-popup.sh",
);
const MISE_CONFIG = resolve(import.meta.dir, "../../config/mise/config.toml");

const SESSION = "testsess";
const USER = process.env.USER ?? "unknown";

const captureFile = (tmp: string): string =>
  join(tmp, `zellij-translate-${USER}`, `${SESSION}.txt`);

/** PATH 先頭に置くスタブ実行ファイルを作る。stdin/引数を実ファイルに記録する。 */
const makeStub = async (
  binDir: string,
  name: string,
  body: string,
): Promise<void> => {
  const path = join(binDir, name);
  await fs.writeFile(path, `#!/bin/sh\n${body}\n`);
  await fs.chmod(path, 0o755);
};

const runScript = async (
  script: string,
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  // Strip any inherited session name so tests control it explicitly
  const { ZELLIJ_SESSION_NAME: _inherited, ...cleanEnv } = process.env;
  const proc = Bun.spawn(["bash", script], {
    env: { ...cleanEnv, ...options.env },
    stdin: new TextEncoder().encode(options.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

const baseEnv = (tmp: string, binDir: string): Record<string, string> => ({
  TMPDIR: tmp,
  PATH: `${binDir}:${process.env.PATH}`,
  ZELLIJ_SESSION_NAME: SESSION,
});

describe("copy-capture.sh", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("non-empty selection is captured with 0600 and piped to pbcopy", async () => {
    const tmp = await setupTestDirectory("zellij-copy", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(binDir, "pbcopy", `cat > "${join(tmp, "clip.txt")}"`);

    const r = await runScript(COPY_CAPTURE, {
      stdin: "hello world",
      env: baseEnv(tmp, binDir),
    });
    expect(r.exitCode).toBe(0);

    const captured = await fs.readFile(captureFile(tmp), "utf-8");
    expect(captured).toBe("hello world");

    const fileMode = (await fs.stat(captureFile(tmp))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode =
      (await fs.stat(join(tmp, `zellij-translate-${USER}`))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const clip = await fs.readFile(join(tmp, "clip.txt"), "utf-8");
    expect(clip).toBe("hello world");
  });

  test("empty stdin (stray click) does not overwrite an existing capture", async () => {
    const tmp = await setupTestDirectory("zellij-copy-empty", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(binDir, "pbcopy", `cat > "${join(tmp, "clip.txt")}"`);

    await fs.mkdir(join(tmp, `zellij-translate-${USER}`), { mode: 0o700 });
    await fs.writeFile(captureFile(tmp), "previous selection", { mode: 0o600 });

    const r = await runScript(COPY_CAPTURE, {
      stdin: "",
      env: baseEnv(tmp, binDir),
    });
    expect(r.exitCode).toBe(0);

    const captured = await fs.readFile(captureFile(tmp), "utf-8");
    expect(captured).toBe("previous selection");

    // pbcopy must not fire for an empty selection
    expect(fs.access(join(tmp, "clip.txt"))).rejects.toThrow();
  });
});

describe("translate-popup.sh", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("pipeline contract: uvx runs pinned PLaMo for English-to-Japanese input", async () => {
    const tmp = await setupTestDirectory("zellij-pipeline", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(binDir, "pbcopy", "cat > /dev/null");
    await makeStub(
      binDir,
      "uvx",
      [
        `printf '%s\\n' "$*" > "${join(tmp, "uvx-args.txt")}"`,
        `cat > "${join(tmp, "plamo-stdin.txt")}"`,
        `printf 'こんにちは、世界'`,
      ].join("\n"),
    );

    const env = baseEnv(tmp, binDir);
    await runScript(COPY_CAPTURE, { stdin: "Hello, world", env });

    const r = await runScript(TRANSLATE_POPUP, { stdin: "\n", env });
    expect(r.exitCode).toBe(0);

    const plamoStdin = await fs.readFile(join(tmp, "plamo-stdin.txt"), "utf-8");
    expect(plamoStdin).toBe("Hello, world\n");
    const uvxArgs = await fs.readFile(join(tmp, "uvx-args.txt"), "utf-8");
    expect(uvxArgs).toBe(
      "--no-config --from plamo-translate==1.0.5 --python 3.14 --with transformers==4.57.6 plamo-translate --from English --to Japanese\n",
    );

    // Translated output is shown in the popup
    expect(r.stdout).toContain("こんにちは、世界");

    // Capture is deleted right after being read (no lingering selection data)
    expect(fs.access(captureFile(tmp))).rejects.toThrow();
  });

  test("falls back to default.txt when the copy hook had no ZELLIJ_SESSION_NAME", async () => {
    const tmp = await setupTestDirectory("zellij-fallback", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(binDir, "pbcopy", "cat > /dev/null");
    await makeStub(
      binDir,
      "uvx",
      `cat > "${join(tmp, "plamo-stdin.txt")}"; printf 'ok'`,
    );

    // copy_command runs from the zellij server: no session name in env
    const { ZELLIJ_SESSION_NAME: _unused, ...hookEnv } = baseEnv(tmp, binDir);
    await runScript(COPY_CAPTURE, { stdin: "fallback text", env: hookEnv });

    // The popup pane does have the session name
    const r = await runScript(TRANSLATE_POPUP, {
      stdin: "\n",
      env: baseEnv(tmp, binDir),
    });
    expect(r.exitCode).toBe(0);

    const plamoStdin = await fs.readFile(join(tmp, "plamo-stdin.txt"), "utf-8");
    expect(plamoStdin).toBe("fallback text\n");
    expect(
      fs.access(join(tmp, `zellij-translate-${USER}`, "default.txt")),
    ).rejects.toThrow();
  });

  test("missing capture: uvx is not invoked and the empty message is shown", async () => {
    const tmp = await setupTestDirectory("zellij-empty-capture", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(
      binDir,
      "uvx",
      `touch "${join(tmp, "uvx-invoked")}"; cat > /dev/null`,
    );

    const r = await runScript(TRANSLATE_POPUP, {
      stdin: "\n",
      env: baseEnv(tmp, binDir),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("翻訳対象が空です");
    expect(fs.access(join(tmp, "uvx-invoked"))).rejects.toThrow();
  });
});

describe("config.kdl copy_command contract", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  // Zellij spawns copy_command WITHOUT a shell, splitting the string on
  // single spaces with no quote handling (CopyCommand::new, zellij-server).
  // This test replicates that exact spawn so quotes or other shell syntax
  // sneaking back into the config value fail here instead of silently in
  // live use.
  test("survives zellij's naive space-splitting and reaches the capture file", async () => {
    const tmp = await setupTestDirectory("zellij-spawn", ["bin"]);
    tmps.push(tmp);
    const binDir = join(tmp, "bin");
    await makeStub(binDir, "pbcopy", `cat > "${join(tmp, "clip.txt")}"`);

    // Fake $HOME whose ~/.config/zellij points at the repo's config dir,
    // like the installed symlink does
    const home = join(tmp, "home");
    await fs.mkdir(join(home, ".config"), { recursive: true });
    await fs.symlink(
      resolve(import.meta.dir, "../../config/zellij"),
      join(home, ".config", "zellij"),
    );

    const kdl = await fs.readFile(
      resolve(import.meta.dir, "../../config/zellij/config.kdl"),
      "utf-8",
    );
    const match = kdl.match(/^copy_command "(.+)"$/m);
    expect(match).not.toBeNull();
    const argv = match![1].split(" ");

    const { ZELLIJ_SESSION_NAME: _inherited, ...cleanEnv } = process.env;
    const proc = Bun.spawn(argv, {
      env: {
        ...cleanEnv,
        HOME: home,
        TMPDIR: tmp,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      stdin: new TextEncoder().encode("split-contract"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // No ZELLIJ_SESSION_NAME in the server env → shared default.txt
    const captured = await fs.readFile(
      join(tmp, `zellij-translate-${USER}`, "default.txt"),
      "utf-8",
    );
    expect(captured).toBe("split-contract");
    const clip = await fs.readFile(join(tmp, "clip.txt"), "utf-8");
    expect(clip).toBe("split-contract");
  });
});

describe("mise tool config", () => {
  test("uses mise-managed uv without a pipx PLaMo installation", async () => {
    const config = await fs.readFile(MISE_CONFIG, "utf8");
    expect(config).toMatch(/^uv = "[^"]+"$/m);
    expect(config).not.toContain("pipx:plamo-translate");
  });
});

describe("script files", () => {
  test("both scripts are executable (git file mode)", async () => {
    await fs.access(COPY_CAPTURE, constants.X_OK);
    await fs.access(TRANSLATE_POPUP, constants.X_OK);
  });
});
