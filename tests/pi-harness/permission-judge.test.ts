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
import type {
  BoundedTaskContext,
  PermissionProjectContext,
  PermissionRunEvidence,
} from "../../pi/extensions/pi-harness/features/permission-policy/context";
import { startMockUpstream, type MockUpstream } from "../test-helpers";

const upstreams: MockUpstream[] = [];
const rawUpstreams: { close: () => Promise<void> }[] = [];

const localStatusResponse = (): Response =>
  Response.json({ cloud: { disabled: true, source: "test" } });

const localTagsResponse = (): Response =>
  Response.json({
    models: [
      {
        name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
        model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
        digest: DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
      },
    ],
  });

const startDirect = async (
  handler: Parameters<typeof startMockUpstream>[0],
): Promise<MockUpstream> => {
  const upstream = await startMockUpstream(handler);
  upstreams.push(upstream);
  return upstream;
};

const start = async (
  chatHandler: Parameters<typeof startMockUpstream>[0],
): Promise<MockUpstream> =>
  startDirect((request, received) => {
    if (received.path === "/api/version") {
      return Response.json({ version: "0.test.0" });
    }
    if (received.path === "/api/status") return localStatusResponse();
    if (received.path === "/api/tags") return localTagsResponse();
    return chatHandler(request, received);
  });

const chatRequests = (upstream: MockUpstream) =>
  upstream.received.filter((request) => request.path === "/api/chat");

const rawJsonResponse = (socket: Socket, payload: unknown): void => {
  const body = JSON.stringify(payload);
  socket.end(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
};

const startRaw = async (
  respond: (socket: Socket) => void,
): Promise<{ url: string }> => {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const requestLine = Buffer.from(data)
        .toString("latin1")
        .split("\r\n", 1)[0];
      if (requestLine === "GET /api/status HTTP/1.1") {
        rawJsonResponse(socket, {
          cloud: { disabled: true, source: "test" },
        });
        return;
      }
      if (requestLine === "GET /api/tags HTTP/1.1") {
        rawJsonResponse(socket, {
          models: [
            {
              name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
              model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
              digest: DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
            },
          ],
        });
        return;
      }
      respond(socket);
    });
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
    model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
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

const taskContext = (
  text: string,
  fingerprint = `task:${text}`,
): BoundedTaskContext => ({
  text,
  source: "interactive",
  fingerprint,
});

const runEvidence = (fingerprint = "run:a"): PermissionRunEvidence => ({
  assistantText: "Inspect the policy after the failed test.",
  priorToolResults: [
    { toolName: "bash", status: "error" },
    { toolName: "read", status: "ok" },
  ],
  fingerprint,
});

const gitProject = (fingerprint = "project:a"): PermissionProjectContext => ({
  kind: "git",
  name: "project",
  cwd: "/private/project-worktree/packages/app",
  activeWorktree: "/private/project-worktree",
  navigableRoots: ["/private/project-worktree", "/private/project"],
  worktrees: ["/private/project-worktree", "/private/project"],
  fingerprint,
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

  test("sends bounded task, current-run evidence, and project context with low-latency options", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));

    expect(
      await judge.judge("git status --short", {
        cwd: "/private/project-worktree/packages/app",
        task: taskContext("Inspect the current repository state"),
        runEvidence: runEvidence(),
        project: gitProject(),
      }),
    ).toEqual({ kind: "allow", cached: false });
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
      "/api/tags",
      "/api/chat",
    ]);
    expect(upstream.received[0]?.body).toBe("");
    expect(upstream.received[1]?.body).toBe("");

    const request = chatRequests(upstream)[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/api/chat");
    const body = JSON.parse(request?.body ?? "") as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: {
        temperature: 0,
        seed: 0,
        num_ctx: 16_384,
        num_predict: 8,
      },
    });
    expect(
      (body.options as Record<string, unknown> | undefined)?.stop,
    ).toBeUndefined();
    expect(request?.body).toContain("git status --short");
    expect(request?.body).toContain("Inspect the current repository state");
    expect(request?.body).toContain(
      "Inspect the policy after the failed test.",
    );
    expect(request?.body).toContain(
      '\\"toolName\\":\\"bash\\",\\"status\\":\\"error\\"',
    );
    expect(request?.body).toContain(
      '\\"toolName\\":\\"read\\",\\"status\\":\\"ok\\"',
    );
    expect(request?.body).toContain("/private/project-worktree");
    expect(request?.body).toContain("/private/project");
    expect(request?.body).not.toContain("task:Inspect");
    expect(request?.body).not.toContain("project:a");
    expect(request?.body).not.toContain("run:a");
    expect(request?.body).not.toContain("conversation history");
    expect(request?.body).not.toContain("systemPromptOptions");
    expect(request?.body).not.toContain("process.env");
  });

  test("copies only precomputed leading-cd scope into the model envelope", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));
    const project = gitProject();

    for (const scope of [
      "listed-worktree",
      "outside-listed-worktrees",
      "unverified",
    ] as const) {
      await judge.judge("cd /private/project-worktree && make test", {
        cwd: project.cwd,
        project,
        leadingNavigation: {
          scope,
          sameRepository: scope === "listed-worktree",
        },
      });
    }

    const bodies = chatRequests(upstream).map((request) => request.body);
    const scopes = bodies.map((body) => {
      const payload = JSON.parse(body) as {
        messages: { role: string; content: string }[];
      };
      const content = payload.messages.find(
        (message) => message.role === "user",
      )?.content;
      if (content === undefined) throw new Error("missing classifier input");
      const envelope = JSON.parse(content.slice(content.indexOf("\n") + 1)) as {
        leadingNavigation?: { scope?: string };
      };
      return envelope.leadingNavigation?.scope;
    });
    expect(scopes).toEqual([
      "listed-worktree",
      "outside-listed-worktrees",
      "unverified",
    ]);
    expect(bodies.join("\n")).not.toContain("project:a");
    expect(bodies.join("\n")).not.toContain("sameRepository");
  });

  test("copies only precomputed git -C scope into the model envelope", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));
    const project = gitProject();

    await judge.judge("git -C /private/project-worktree status --short", {
      cwd: project.cwd,
      project,
      gitCwd: {
        scope: "listed-worktree",
        sameRepository: true,
      },
    });

    const body = chatRequests(upstream)[0]?.body ?? "";
    const payload = JSON.parse(body) as {
      messages: { role: string; content: string }[];
    };
    const content = payload.messages.find(
      (message) => message.role === "user",
    )?.content;
    if (content === undefined) throw new Error("missing classifier input");
    const envelope = JSON.parse(content.slice(content.indexOf("\n") + 1)) as {
      gitCwd?: { scope?: string };
    };
    expect(envelope.gitCwd?.scope).toBe("listed-worktree");
    expect(body).not.toContain("sameRepository");
  });

  test("fails closed before chat when Ollama cloud is not disabled", async () => {
    const upstream = await startDirect((_request, received) => {
      if (received.path === "/api/status") {
        return Response.json({ cloud: { disabled: false, source: "test" } });
      }
      if (received.path === "/api/tags") return localTagsResponse();
      return validResponse();
    });

    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "echo secret-command",
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "local Ollama cloud features are not disabled",
    });
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
    ]);
  });

  test.each([
    {
      label: "digest mismatch",
      tags: {
        models: [
          {
            name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            digest: "a".repeat(64),
          },
        ],
      },
    },
    {
      label: "remote alias",
      tags: {
        models: [
          {
            name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            digest: DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
            remote_host: "https://ollama.example",
          },
        ],
      },
    },
    { label: "missing configured model", tags: { models: [] } },
    { label: "malformed model list", tags: { models: {} } },
  ])("fails closed before chat for $label", async ({ tags }) => {
    const upstream = await startDirect((_request, received) => {
      if (received.path === "/api/status") return localStatusResponse();
      if (received.path === "/api/tags") return Response.json(tags);
      return validResponse();
    });

    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "echo secret-command",
    );
    expect(outcome.kind).toBe("unavailable");
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
      "/api/tags",
    ]);
  });

  test.each([
    {
      label: "unexpected model",
      response: {
        model: "other:latest",
        message: { role: "assistant", content: "ALLOW" },
        done: true,
        done_reason: "stop",
      },
    },
    {
      label: "remote response metadata",
      response: {
        model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
        remote_model: "upstream-model",
        remote_host: "https://ollama.example",
        message: { role: "assistant", content: "ALLOW" },
        done: true,
        done_reason: "stop",
      },
    },
  ])("rejects $label after a valid preflight", async ({ response }) => {
    const upstream = await start(() => Response.json(response));
    const outcome = await createPermissionJudge(configFor(upstream)).judge(
      "git status",
    );
    expect(outcome.kind).toBe("invalid-response");
  });

  test("does not start chat after preflight exhausts the shared budget", async () => {
    const upstream = await start(() => validResponse());
    let clockCalls = 0;
    const judge = createPermissionJudge(
      configFor(upstream, { timeoutMs: 25 }),
      {
        monotonicNow: () => (clockCalls++ === 0 ? 0 : 25),
      },
    );

    expect((await judge.judge("git status")).kind).toBe("timeout");
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
      "/api/tags",
    ]);
  });

  test("does not accept a chat response after the shared deadline", async () => {
    const upstream = await start(() => validResponse());
    const readings = [0, 0, 25];
    const judge = createPermissionJudge(
      configFor(upstream, { timeoutMs: 25 }),
      {
        monotonicNow: () => readings.shift() ?? 25,
      },
    );

    expect((await judge.judge("git status")).kind).toBe("timeout");
    expect(chatRequests(upstream)).toHaveLength(1);
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
      label: "whitespace-padded verdict",
      payload: {
        message: { role: "assistant", content: " ALLOW\n" },
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
    const upstream = await start(() =>
      Response.json({
        model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
        ...payload,
      }),
    );
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
      model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
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
        model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
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

  test("rejects invalid UTF-8 even when replacement decoding would preserve ALLOW", async () => {
    const prefix = Buffer.from(
      JSON.stringify({
        model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
        message: { role: "assistant", content: "ALLOW" },
        done: true,
        done_reason: "stop",
        ignored: "",
      }).replace('"ignored":""', '"ignored":"'),
    );
    const body = Buffer.concat([
      prefix,
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    expect(JSON.parse(body.toString("utf8"))).toMatchObject({
      message: { content: "ALLOW" },
    });
    const lossyUpstream = await start(
      () => new Response(body.toString("utf8")),
    );
    expect(
      await createPermissionJudge(configFor(lossyUpstream)).judge("git status"),
    ).toEqual({ kind: "allow", cached: false });

    const upstream = await startRaw((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
          ),
          body,
        ]),
      );
    });

    const outcome = await createPermissionJudge({
      ...DEFAULT_PERMISSION_JUDGE_CONFIG,
      url: `${upstream.url}/api/chat`,
    }).judge("git status");
    expect(outcome).toEqual({
      kind: "invalid-response",
      reason: "local judge response was not valid UTF-8",
    });
  });

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
      import { createPermissionJudge, readLocalOllamaVersion } from ${JSON.stringify(moduleUrl)};
      const config = ${JSON.stringify(configFor(target))};
      const version = await readLocalOllamaVersion(config);
      const outcome = await createPermissionJudge(config).judge("git status");
      console.log(JSON.stringify({ version, outcome }));
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
    expect(JSON.parse(stdout.trim())).toEqual({
      version: "0.test.0",
      outcome: { kind: "allow", cached: false },
    });
    expect(target.received.map((request) => request.path)).toContain(
      "/api/version",
    );
    expect(chatRequests(target)).toHaveLength(1);
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
    expect(chatRequests(origin)).toHaveLength(1);
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
      model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
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
    const unavailableProject: PermissionProjectContext = {
      kind: "unavailable",
      reason: "discovery timed out before cwd canonicalization",
      fingerprint: "project:unavailable-without-cwd",
    };

    const firstCwd = await judge.judge("git status", {
      cwd: "/a",
      project: unavailableProject,
    });
    expect(firstCwd.kind).toBe("allow");
    expect(
      await judge.judge("git status", {
        cwd: "/a",
        project: unavailableProject,
      }),
    ).toEqual({ kind: "allow", cached: true });
    const secondCwd = await judge.judge("git status", {
      cwd: "/b",
      project: unavailableProject,
    });
    expect(secondCwd.kind).toBe("allow");
    expect(chatRequests(upstream)).toHaveLength(2);
  });

  test("does not share ALLOW cache entries across task, run evidence, or project changes", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));
    const command = "make check";

    await judge.judge(command, {
      cwd: "/private/project",
      task: taskContext("Run checks…", "complete-task-a"),
      runEvidence: runEvidence("complete-run-a"),
      project: gitProject("complete-project-a"),
    });
    expect(
      await judge.judge(command, {
        cwd: "/private/project",
        task: taskContext("Run checks…", "complete-task-a"),
        runEvidence: runEvidence("complete-run-a"),
        project: gitProject("complete-project-a"),
      }),
    ).toEqual({ kind: "allow", cached: true });

    await judge.judge(command, {
      cwd: "/private/project",
      task: taskContext("Run checks…", "complete-task-b"),
      runEvidence: runEvidence("complete-run-a"),
      project: gitProject("complete-project-a"),
    });
    await judge.judge(command, {
      cwd: "/private/project",
      task: taskContext("Run checks…", "complete-task-b"),
      runEvidence: runEvidence("complete-run-b"),
      project: gitProject("complete-project-a"),
    });
    await judge.judge(command, {
      cwd: "/private/project",
      task: taskContext("Run checks…", "complete-task-b"),
      runEvidence: runEvidence("complete-run-b"),
      project: gitProject("complete-project-b"),
    });

    expect(chatRequests(upstream)).toHaveLength(4);
  });

  test("never reads or writes ALLOW cache while task correlation is unknown", async () => {
    const upstream = await start(() => validResponse());
    const judge = createPermissionJudge(configFor(upstream));
    const context = {
      cwd: "/private/project",
      taskCorrelation: "uncorrelated" as const,
      project: gitProject("complete-project-a"),
    };

    expect((await judge.judge("make check", context)).kind).toBe("allow");
    expect((await judge.judge("make check", context)).kind).toBe("allow");
    expect(chatRequests(upstream)).toHaveLength(2);

    const noTaskContext = {
      cwd: "/private/project",
      taskCorrelation: "none" as const,
      project: gitProject("complete-project-a"),
    };
    expect((await judge.judge("make check", noTaskContext)).kind).toBe("allow");
    expect(await judge.judge("make check", noTaskContext)).toEqual({
      kind: "allow",
      cached: true,
    });
    expect(chatRequests(upstream)).toHaveLength(3);
  });

  test("keeps caches isolated between judge instances", async () => {
    const upstream = await start(() => validResponse());
    const first = createPermissionJudge(configFor(upstream));
    const second = createPermissionJudge(configFor(upstream));

    expect((await first.judge("git status")).kind).toBe("allow");
    expect((await second.judge("git status")).kind).toBe("allow");
    expect(chatRequests(upstream)).toHaveLength(2);
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
    expect(chatRequests(upstream)).toHaveLength(4);

    now = 101;
    await judge.judge("A");
    expect(chatRequests(upstream)).toHaveLength(5);
  });

  test("opens a short fail-closed circuit after backend failure", async () => {
    const upstream = await start(() => new Response("down", { status: 503 }));
    const judge = createPermissionJudge(configFor(upstream));

    expect((await judge.judge("git status")).kind).toBe("unavailable");
    expect((await judge.judge("git log -1")).kind).toBe("unavailable");
    expect(chatRequests(upstream)).toHaveLength(1);
  });

  test("does not cache ASK outcomes and clear removes cached approvals", async () => {
    let content = "ASK";
    const upstream = await start(() => validResponse(content));
    const judge = createPermissionJudge(configFor(upstream));

    await judge.judge("git status");
    await judge.judge("git status");
    expect(chatRequests(upstream)).toHaveLength(2);

    content = "ALLOW";
    await judge.judge("git status");
    await judge.judge("git status");
    expect(chatRequests(upstream)).toHaveLength(3);
    judge.clear();
    await judge.judge("git status");
    expect(chatRequests(upstream)).toHaveLength(4);
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
