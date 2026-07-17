import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHook,
  fireDetachedHook,
} from "../../pi/extensions/pi-harness/lib/run-hook";

const cleanups: string[] = [];

async function makeScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-hook-"));
  cleanups.push(dir);
  const path = join(dir, "hook.sh");
  await writeFile(path, content, { mode: 0o755 });
  return path;
}

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runHook", () => {
  test("captures stdout and exit code 0", async () => {
    const script = await makeScript(
      "#!/usr/bin/env bash\ncat > /dev/null\necho '{\"ok\":true}'\n",
    );
    const result = await runHook(script, "{}", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('{"ok":true}');
  });

  test("delivers stdin JSON to the script", async () => {
    const script = await makeScript(
      "#!/usr/bin/env bash\ninput=$(cat)\nprintf '%s' \"$input\"\n",
    );
    const result = await runHook(script, '{"tool_name":"Bash"}', {
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('{"tool_name":"Bash"}');
  });

  test("captures exit 2 with stderr (Claude hook block contract)", async () => {
    const script = await makeScript(
      '#!/usr/bin/env bash\ncat > /dev/null\necho "denied by hook" >&2\nexit 2\n',
    );
    const result = await runHook(script, "{}", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe("denied by hook");
  });

  test("kills a hanging script after injected timeout", async () => {
    const script = await makeScript(
      "#!/usr/bin/env bash\ncat > /dev/null\nsleep 30\n",
    );
    const started = Date.now();
    const result = await runHook(script, "{}", {
      timeoutMs: 300,
      termGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("aborts the hook process group without reporting a timeout", async () => {
    const script = await makeScript(
      "#!/usr/bin/env bash\ncat > /dev/null\ntrap '' TERM\nsleep 30\n",
    );
    const controller = new AbortController() as unknown as {
      signal: AbortSignal;
      abort(): void;
    };
    const started = Date.now();
    const execution = runHook(script, "{}", {
      timeoutMs: 5_000,
      termGraceMs: 50,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await execution;
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("Hook aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("survives a script that never reads stdin", async () => {
    const script = await makeScript(
      '#!/usr/bin/env bash\necho "ignored stdin"\n',
    );
    const result = await runHook(script, `{"pad":"${"x".repeat(200_000)}"}`, {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ignored stdin");
  });

  test("caps captured output at maxOutputBytes", async () => {
    const script = await makeScript(
      "#!/usr/bin/env bash\ncat > /dev/null\nhead -c 100000 /dev/zero | tr '\\0' 'a'\n",
    );
    const result = await runHook(script, "{}", {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });
});

describe("fireDetachedHook", () => {
  test("runs without blocking and leaves a side effect (polled)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-detached-"));
    cleanups.push(dir);
    const marker = join(dir, "marker.txt");
    const script = join(dir, "hook.sh");
    await writeFile(
      script,
      `#!/usr/bin/env bash\ninput=$(cat)\nprintf '%s' "$input" > "${marker}"\n`,
      {
        mode: 0o755,
      },
    );

    fireDetachedHook(script, '{"event":"detached"}');

    let content = "";
    for (let i = 0; i < 50; i++) {
      try {
        content = await readFile(marker, "utf8");
        if (content !== "") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(content).toBe('{"event":"detached"}');
  });
});
