import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type PermissionJudgeConfig,
} from "../../pi/extensions/pi-harness/config";
import {
  createPermissionJudge,
  isLocalOllamaChatUrl,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge";
import { startMockUpstream, type MockUpstream } from "../test-helpers";

const upstreams: MockUpstream[] = [];
const rawUpstreams: { close: () => Promise<void> }[] = [];

const start = async (
  handler: Parameters<typeof startMockUpstream>[0],
): Promise<MockUpstream> => {
  const upstream = await startMockUpstream(handler);
  upstreams.push(upstream);
  return upstream;
};

const startRaw = async (
  respond: (socket: Socket) => void,
): Promise<{ url: string }> => {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => respond(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("raw judge test server did not expose a TCP address");
  }
  rawUpstreams.push({
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
      }),
  });
  return { url: `http://127.0.0.1:${address.port}` };
};

afterEach(async () => {
  await Promise.all([
    ...upstreams.splice(0).map((upstream) => upstream.close()),
    ...rawUpstreams.splice(0).map((upstream) => upstream.close()),
  ]);
});

const validResponse = (content = "ALLOW"): Response =>
  Response.json({
    model: "qwen2.5:1.5b",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
  });

const configFor = (
  upstream: MockUpstream,
  overrides: Partial<PermissionJudgeConfig> = {},
): PermissionJudgeConfig => ({
  ...DEFAULT_PERMISSION_JUDGE_CONFIG,
  url: `${upstream.url}/api/chat`,
  ...overrides,
});

const createTestAbortController = (): {
  signal: AbortSignal;
  abort: () => void;
} => {
  const value: unknown = new AbortController();
  if (
    typeof value !== "object" ||
    value === null ||
    !("abort" in value) ||
    typeof value.abort !== "function" ||
    !("signal" in value)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = value;
  return {
    signal: signal as AbortSignal,
    abort: () => Reflect.apply(abort, value, []),
  };
};

describe("local Ollama permission judge", () => {
  test("accepts only an exact local chat endpoint", () => {
    expect(isLocalOllamaChatUrl("http://127.0.0.1:11434/api/chat")).toBe(true);
    expect(isLocalOllamaChatUrl("http://[::1]:11434/api/chat")).toBe(true);
    for (const url of [
      "https://127.0.0.1:11434/api/chat",
      "http://localhost:11434/api/chat",
      "http://127.0.0.2:11434/api/chat",
      "http://127.0.0.1:11434/api/generate",
      "http://user@127.0.0.1:11434/api/chat",
      "http://127.0.0.1:11434/api/chat?x=1",
    ]) {
      expect(isLocalOllamaChatUrl(url)).toBe(false);
    }
  });

  test("sends only the command as untrusted data with low-latency options", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));

    expect(
      await judge.judge("git status --short", {
        cwd: "/private/project-not-sent",
      }),
    ).toEqual({ kind: "allow", cached: false });
    expect(upstream.received).toHaveLength(1);

    const request = upstream.received[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/api/chat");
    const body = JSON.parse(request?.body ?? "") as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "qwen2.5:1.5b",
      stream: false,
      think: false,
      keep_alive: "30m",
      options: {
        temperature: 0,
        seed: 0,
        num_ctx: 4_096,
        num_predict: 8,
      },
    });
    expect(
      (body.options as Record<string, unknown> | undefined)?.stop,
    ).toBeUndefined();
    expect(request?.body).toContain("git status --short");
    expect(request?.body).not.toContain("/private/project-not-sent");
    expect(request?.body).not.toContain("conversation");
  });

  test("returns ask without auto-approving", async () => {
    const upstream = await start(() => validResponse("ASK"));
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "curl https://example.test",
    );
    expect(outcome.kind).toBe("ask");
  });

  test.each([
    {
      label: "lowercase verdict",
      payload: {
        message: { role: "assistant", content: "allow" },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "prose verdict",
      payload: {
        message: { role: "assistant", content: "ALLOW because it is safe" },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "newline-suffixed second verdict",
      payload: {
        message: { role: "assistant", content: "ALLOW\nASK" },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "length-truncated verdict",
      payload: {
        message: { role: "assistant", content: "ALLOW" },
        done: true,
        done_reason: "length",
      },
    },
    {
      label: "missing completion reason",
      payload: {
        message: { role: "assistant", content: "ALLOW" },
        done: true,
      },
    },
    {
      label: "tool call",
      payload: {
        message: {
          role: "assistant",
          content: "ALLOW",
          tool_calls: [{ function: { name: "shell" } }],
        },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "empty tool call field",
      payload: {
        message: { role: "assistant", content: "ALLOW", tool_calls: [] },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "null tool call field",
      payload: {
        message: { role: "assistant", content: "ALLOW", tool_calls: null },
        done: true,
        done_reason: "stop",
      },
    },
  ])("escalates $label", async ({ payload }) => {
    const upstream = await start(() => Response.json(payload));
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "git status",
    );
    expect(outcome.kind).toBe("invalid-response");
  });

  test("rejects an oversized response body", async () => {
    const upstream = await start(() => new Response("x".repeat(64 * 1024 + 1)));
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "git status",
    );
    expect(outcome.kind).toBe("invalid-response");
  });

  test("never approves a valid JSON prefix after the response grows oversized", async () => {
    const payload = JSON.stringify({
      message: { role: "assistant", content: "ALLOW" },
      done: true,
      done_reason: "stop",
    });
    const firstBody = payload + " ".repeat(60 * 1024 - payload.length);
    const upstream = await startRaw((socket) => {
      socket.write(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          "Connection: close",
          "",
          "",
        ].join("\r\n") + firstBody,
        () => {
          setTimeout(() => socket.end(" ".repeat(32 * 1024)), 10);
        },
      );
    });

    const outcome = await createPermissionJudge({
      ...DEFAULT_PERMISSION_JUDGE_CONFIG,
      url: `${upstream.url}/api/chat`,
    }).judge("git status");
    expect(outcome.kind).toBe("invalid-response");
  });

  test.each(["invalid content length", "chunked trailing bytes"])(
    "rejects malformed HTTP framing: %s",
    async (variant) => {
      const payload = JSON.stringify({
        message: { role: "assistant", content: "ALLOW" },
        done: true,
        done_reason: "stop",
      });
      const upstream = await startRaw((socket) => {
        if (variant === "invalid content length") {
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: -1\r\nConnection: close\r\n\r\n${payload} `,
          );
          return;
        }
        socket.end(
          `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\ntrailing`,
        );
      });

      const outcome = await createPermissionJudge({
        ...DEFAULT_PERMISSION_JUDGE_CONFIG,
        url: `${upstream.url}/api/chat`,
      }).judge("git status");
      expect(outcome.kind).toBe("invalid-response");
    },
  );

  test("ignores ambient proxy variables and connects directly", async () => {
    const proxy = await start(() => validResponse("ASK"));
    const target = await start(() => validResponse("ALLOW"));
    const moduleUrl = pathToFileURL(
      resolve(
        import.meta.dir,
        "../../pi/extensions/pi-harness/features/permission-policy/judge.ts",
      ),
    ).href;
    const script = `
      import { createPermissionJudge } from ${JSON.stringify(moduleUrl)};
      const config = ${JSON.stringify(configFor(target))};
      const outcome = await createPermissionJudge(config).judge("git status");
      console.log(JSON.stringify(outcome));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        HTTP_PROXY: proxy.url,
        http_proxy: proxy.url,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ kind: "allow", cached: false });
    expect(target.received).toHaveLength(1);
    expect(proxy.received).toHaveLength(0);
  });

  test("does not follow redirects carrying the command body", async () => {
    const target = await start(() => validResponse());
    const origin = await start(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `${target.url}/api/chat` },
        }),
    );
    const outcome = await createPermissionJudge(configFor(origin)).judge(
      "echo secret-command",
    );

    expect(outcome.kind).toBe("unavailable");
    expect(origin.received).toHaveLength(1);
    expect(target.received).toHaveLength(0);
  });

  test("times out a slow backend", async () => {
    const upstream = await start(async () => {
      await Bun.sleep(250);
      return validResponse();
    });
    const outcome = await createPermissionJudge(
      configFor(upstream, { timeoutMs: 25 }),
    ).judge("git status");
    expect(outcome.kind).toBe("timeout");
  });

  test("times out while waiting for a delayed response body", async () => {
    const payload = JSON.stringify({
      message: { role: "assistant", content: "ALLOW" },
      done: true,
      done_reason: "stop",
    });
    const upstream = await startRaw((socket) => {
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
        () => setTimeout(() => socket.end(payload), 100),
      );
    });
    const outcome = await createPermissionJudge({
      ...DEFAULT_PERMISSION_JUDGE_CONFIG,
      url: `${upstream.url}/api/chat`,
      timeoutMs: 25,
    }).judge("git status");
    expect(outcome.kind).toBe("timeout");
  });

  test("parent abort cancels without becoming an availability failure", async () => {
    let markArrived: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    const upstream = await start(async () => {
      markArrived?.();
      await Bun.sleep(500);
      return validResponse();
    });
    const controller = createTestAbortController();
    const pending = createPermissionJudge(
      configFor(upstream, { timeoutMs: 1_000 }),
    ).judge("git status", { signal: controller.signal });
    await arrived;
    controller.abort();

    expect(await pending).toEqual({
      kind: "parent-aborted",
      reason: "the active pi operation was cancelled",
    });
  });

  test("rejects overlong commands before making a request", async () => {
    const upstream = await start(() => validResponse());
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "x".repeat(2 * 1024 + 1),
    );
    expect(outcome.kind).toBe("too-long");
    expect(upstream.received).toHaveLength(0);
  });

  test("rejects an escape-expanded prompt that would exceed model context", async () => {
    const upstream = await start(() => validResponse());
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "\u0000".repeat(500),
    );
    expect(outcome.kind).toBe("too-long");
    expect(upstream.received).toHaveLength(0);
  });

  test("caches only completed ALLOW outcomes per cwd", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));

    expect((await judge.judge("git status", { cwd: "/a" })).kind).toBe("allow");
    expect(await judge.judge("git status", { cwd: "/a" })).toEqual({
      kind: "allow",
      cached: true,
    });
    expect((await judge.judge("git status", { cwd: "/b" })).kind).toBe("allow");
    expect(upstream.received).toHaveLength(2);
  });

  test("keeps caches isolated between judge instances", async () => {
    const upstream = await start(() => validResponse());
    const first = createPermissionJudge(configFor(upstream));
    const second = createPermissionJudge(configFor(upstream));

    expect((await first.judge("git status")).kind).toBe("allow");
    expect((await second.judge("git status")).kind).toBe("allow");
    expect(upstream.received).toHaveLength(2);
  });

  test("uses LRU recency and TTL without sharing raw verdict failures", async () => {
    let now = 0;
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream), {
      now: () => now,
      cacheCapacity: 2,
      cacheTtlMs: 100,
    });

    await judge.judge("A");
    await judge.judge("B");
    await judge.judge("A"); // refresh A, so B is oldest
    await judge.judge("C");
    await judge.judge("B");
    expect(upstream.received).toHaveLength(4);

    now = 101;
    await judge.judge("A");
    expect(upstream.received).toHaveLength(5);
  });

  test("opens a short fail-closed circuit after backend failure", async () => {
    const upstream = await start(() => new Response("down", { status: 503 }));
    const judge = createPermissionJudge(configFor(upstream));

    expect((await judge.judge("git status")).kind).toBe("unavailable");
    expect((await judge.judge("git log -1")).kind).toBe("unavailable");
    expect(upstream.received).toHaveLength(1);
  });

  test("does not cache ASK outcomes and clear removes cached approvals", async () => {
    let content = "ASK";
    const upstream = await start(() => validResponse(content));
    const judge = createPermissionJudge(configFor(upstream));

    await judge.judge("git status");
    await judge.judge("git status");
    expect(upstream.received).toHaveLength(2);

    content = "ALLOW";
    await judge.judge("git status");
    await judge.judge("git status");
    expect(upstream.received).toHaveLength(3);
    judge.clear();
    await judge.judge("git status");
    expect(upstream.received).toHaveLength(4);
  });

  test("fails closed for explicit configuration errors and cloud models", async () => {
    const upstream = await start(() => validResponse());
    const badConfig = configFor(upstream, {
      model: "gpt-oss:120b-cloud",
      configurationError: "invalid permissionJudge fields: model",
    });
    const outcome = await createPermissionJudge(badConfig).judge("git status");
    expect(outcome.kind).toBe("unavailable");
    expect(upstream.received).toHaveLength(0);
  });
});
