import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  AuthStorage,
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
  type PermissionJudgeConfig,
} from "../../pi/extensions/pi-harness/config";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import {
  evaluateCommandWithSkillAllows,
  resolveActiveSkillBashAllows,
} from "../../pi/extensions/pi-harness/features/permission-policy/skill-allow";
import { loadRules } from "../../pi/extensions/pi-harness/features/permission-policy/rules";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type {
  BeforeAgentStartEvent,
  PiLike,
  ToolCallEvent,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { startMockUpstream, type MockUpstream } from "../test-helpers";
import { createFakePi, type FakePi } from "./fake-pi";

const execFileAsync = promisify(execFile);

const upstreams: MockUpstream[] = [];
const temporaryDirectories: string[] = [];

const stripFrontmatter = (markdown: string): string => {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  return end === -1 ? normalized.trim() : normalized.slice(end + 4).trim();
};

const expandedSkillPrompt = (
  name: string,
  filePath: string,
  markdown: string,
  args?: string,
): string => {
  const block = `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${stripFrontmatter(markdown)}\n</skill>`;
  return args === undefined ? block : `${block}\n\n${args}`;
};

const eventFor = (
  name: string,
  filePath: string,
  markdown: string,
  args?: string,
): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  prompt: expandedSkillPrompt(name, filePath, markdown, args),
  systemPromptOptions: {
    skills: [
      {
        name,
        description: "test skill",
        filePath,
        baseDir: dirname(filePath),
      },
    ],
  },
});

const makeSkill = async (
  allowedTools: string,
): Promise<{
  filePath: string;
  markdown: string;
}> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-skill-allow-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "SKILL.md");
  const markdown = `---\nname: safe-release\ndescription: Test release workflow\nallowed-tools: ${allowedTools}\n---\n\n## Workflow\n\nPush the reviewed branch.\n`;
  await fs.writeFile(filePath, markdown, "utf8");
  return { filePath, markdown };
};

const startJudge = async (): Promise<MockUpstream> => {
  const upstream = await startMockUpstream((_request, received) => {
    if (received.path === "/api/status") {
      return Response.json({ cloud: { disabled: true, source: "test" } });
    }
    if (received.path === "/api/tags") {
      return Response.json({
        models: [
          {
            name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            digest: DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
          },
        ],
      });
    }
    return Response.json({
      model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
      message: { role: "assistant", content: "ASK" },
      done: true,
      done_reason: "stop",
    });
  });
  upstreams.push(upstream);
  return upstream;
};

const judgeConfig = (upstream: MockUpstream): PermissionJudgeConfig => ({
  ...DEFAULT_PERMISSION_JUDGE_CONFIG,
  url: `${upstream.url}/api/chat`,
});

const makeConfig = (
  permissionJudge: PermissionJudgeConfig,
  isChild = false,
): HarnessConfig => ({
  isChild,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-permission-skill-policy"),
  permissionJudge,
});

const bashCall = (command: string, id = "skill-bash"): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: id,
  input: { command },
});

const chatRequests = (upstream: MockUpstream) =>
  upstream.received.filter((request) => request.path === "/api/chat");

const userMessage = (text: string, timestamp: number) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const emitInput = (
  pi: FakePi,
  text: string,
  options: {
    source?: "interactive" | "rpc" | "extension";
    streamingBehavior?: "steer" | "followUp";
  } = {},
): Promise<void> =>
  pi.emitInput({
    type: "input",
    text,
    source: options.source ?? "interactive",
    ...(options.streamingBehavior === undefined
      ? {}
      : { streamingBehavior: options.streamingBehavior }),
  });

const activateSkill = async (
  pi: FakePi,
  event: BeforeAgentStartEvent,
  rawInput: string,
  timestamp = 1,
): Promise<void> => {
  await emitInput(pi, rawInput);
  await pi.emitBeforeAgentStart(event);
  await pi.emitContext([userMessage(event.prompt, timestamp)]);
};

const withoutInputLifecycle = (pi: FakePi): FakePi => {
  const originalOn = pi.on.bind(pi);
  const mutable = pi as unknown as { on: FakePi["on"] };
  mutable.on = ((event: Parameters<FakePi["on"]>[0], handler: never) => {
    if (event === "input") throw new Error("input events unavailable");
    (originalOn as (name: typeof event, callback: never) => void)(
      event,
      handler,
    );
  }) as FakePi["on"];
  return pi;
};

const makeGitRepositories = async (): Promise<{
  root: string;
  linked: string;
  unrelated: string;
}> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-skill-repos-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "root");
  const linked = join(directory, "linked");
  const unrelated = join(directory, "unrelated");
  await fs.mkdir(root);
  await fs.mkdir(unrelated);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Pi Test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.email", "pi@example.invalid"], {
    cwd: root,
  });
  await fs.writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
    { cwd: root },
  );
  await execFileAsync("git", ["worktree", "add", "-qb", "linked", linked], {
    cwd: root,
  });
  await execFileAsync("git", ["init", "-q"], { cwd: unrelated });
  return { root, linked, unrelated };
};

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("active skill allowed-tools permission grants", () => {
  test("follows real Pi raw-input and skill-expansion lifecycle", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(echo skill-ok)");
    const root = await fs.mkdtemp(join(tmpdir(), "pi-skill-session-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    await fs.mkdir(agentDir);

    const faux = registerFauxProvider({
      api: `permission-skill-${crypto.randomUUID()}`,
      provider: `permission-skill-${crypto.randomUUID()}`,
      tokensPerSecond: 100_000,
    });
    const model = faux.getModel();
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "test-key");
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(agentDir, "models.json"),
    );
    let expandedPrompt: string | undefined;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      skillsOverride: () => ({
        skills: [
          {
            name: "safe-release",
            description: "test skill",
            filePath: skill.filePath,
            baseDir: dirname(skill.filePath),
            sourceInfo: createSyntheticSourceInfo(skill.filePath, {
              source: "sdk",
            }),
            disableModelInvocation: false,
          },
        ],
        diagnostics: [],
      }),
      extensionFactories: [
        (api) => {
          setupPermissionPolicy(
            api as unknown as PiLike,
            makeConfig(judgeConfig(upstream)),
          );
        },
        (api) => {
          api.on("before_agent_start", (event) => {
            expandedPrompt = event.prompt;
          });
        },
      ],
    });
    await loader.reload();

    const responses = () => [
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo skill-ok" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ];
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });

    try {
      faux.setResponses(responses());
      await session.prompt("/skill:safe-release");
      expect(expandedPrompt).toStartWith('<skill name="safe-release"');
      expect(chatRequests(upstream)).toHaveLength(0);
      expect(
        session.messages.some(
          (message) =>
            message.role === "toolResult" &&
            JSON.stringify(message).includes("skill-ok"),
        ),
      ).toBe(true);

      faux.setResponses(responses());
      await session.prompt(expandedPrompt ?? "");
      expect(chatRequests(upstream)).toHaveLength(1);
    } finally {
      session.dispose();
      faux.unregister();
    }
  });

  test("authenticates explicit skill input across queued contexts", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *), Read");
    const pi = createFakePi({ hasUI: false, cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    const skillEvent = eventFor(
      "safe-release",
      skill.filePath,
      skill.markdown,
      "publish it",
    );
    await activateSkill(pi, skillEvent, "/skill:safe-release publish it");
    expect(
      await pi.emitToolCall(bashCall("git push -u origin safe-release")),
    ).toBeUndefined();
    expect(chatRequests(upstream)).toHaveLength(0);

    await emitInput(pi, "ordinary queued follow-up", {
      streamingBehavior: "followUp",
    });
    await pi.emitContext([
      userMessage(skillEvent.prompt, 1),
      userMessage("ordinary queued follow-up", 2),
    ]);
    expect(
      await pi.emitToolCall(
        bashCall("git push -u origin another", "after-reset"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);

    await emitInput(pi, "/skill:safe-release publish it", {
      streamingBehavior: "steer",
    });
    await pi.emitContext([
      userMessage(skillEvent.prompt, 1),
      userMessage("ordinary queued follow-up", 2),
      userMessage(skillEvent.prompt, 3),
    ]);
    expect(
      await pi.emitToolCall(
        bashCall("git push -u origin queued-skill", "queued"),
      ),
    ).toBeUndefined();
    expect(chatRequests(upstream)).toHaveLength(0);

    await pi.emitAgentSettled();
    expect(
      await pi.emitToolCall(
        bashCall("git push -u origin after-settled", "settled"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("does not trust pasted expansions or extension-generated input", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *)");
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const pi = createFakePi({ hasUI: false, cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    await emitInput(pi, event.prompt);
    await pi.emitBeforeAgentStart(event);
    await pi.emitContext([userMessage(event.prompt, 1)]);
    expect(
      await pi.emitToolCall(bashCall("git push origin pasted", "pasted")),
    ).toMatchObject({ block: true });

    await pi.emitAgentSettled();
    await emitInput(pi, "/skill:safe-release", { source: "extension" });
    await pi.emitBeforeAgentStart(event);
    await pi.emitContext([userMessage(event.prompt, 2)]);
    expect(
      await pi.emitToolCall(
        bashCall("git push origin extension", "extension-generated"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("snapshots allowed-tools for the active run", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *)");
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const pi = createFakePi({ hasUI: false, cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));
    await activateSkill(pi, event, "/skill:safe-release");

    await fs.writeFile(
      skill.filePath,
      skill.markdown.replace(
        "allowed-tools: Bash(git push *)",
        "allowed-tools: Bash(git push *), Bash(echo widened)",
      ),
      "utf8",
    );
    await emitInput(pi, "/skill:safe-release", {
      streamingBehavior: "steer",
    });
    await pi.emitContext([
      userMessage(event.prompt, 1),
      userMessage(event.prompt, 2),
    ]);

    expect(
      await pi.emitToolCall(bashCall("echo widened", "widened-frontmatter")),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(1);
  });

  test("does not replay a dequeued queued-skill capability", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *)");
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const pi = createFakePi({ hasUI: false, cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));
    await activateSkill(pi, event, "/skill:safe-release");

    // Pi can dequeue an expanded queued message back into the editor without
    // an extension event. Model that by retaining the old capability record,
    // submitting a newer non-skill input, and delivering only the newer text.
    await emitInput(pi, "/skill:safe-release", {
      streamingBehavior: "steer",
    });
    await emitInput(pi, "/template:forged-expansion", {
      streamingBehavior: "followUp",
    });
    await pi.emitContext([
      userMessage(event.prompt, 1),
      userMessage(event.prompt, 2),
    ]);
    expect(
      await pi.emitToolCall(bashCall("git push origin replayed", "replayed")),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("fails closed when raw-input lifecycle tracking is unavailable", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *)");
    const pi = withoutInputLifecycle(
      createFakePi({ hasUI: false, cwd: "/tmp/project" }),
    );
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    await pi.emitBeforeAgentStart(event);
    await pi.emitContext([userMessage(event.prompt, 1)]);
    expect(
      await pi.emitToolCall(
        bashCall("git push -u origin no-input-event", "no-input-event"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("does not activate skill grants in a child profile", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill("Bash(git push *)");
    const pi = createFakePi({ hasUI: false, cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream), true));

    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    await activateSkill(pi, event, "/skill:safe-release");
    expect(
      await pi.emitToolCall(bashCall("git push -u origin child", "child")),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("requires an exact expansion of a skill from the loaded skill set", async () => {
    const skill = await makeSkill("Bash(git -C * push *)");
    const trusted = eventFor("safe-release", skill.filePath, skill.markdown);
    expect(
      resolveActiveSkillBashAllows(trusted, "/skill:safe-release"),
    ).toHaveLength(1);

    expect(resolveActiveSkillBashAllows(trusted, trusted.prompt)).toEqual([]);
    expect(
      resolveActiveSkillBashAllows(
        {
          ...trusted,
          prompt: trusted.prompt.replace(
            "Push the reviewed branch.",
            "Push anything.",
          ),
        },
        "/skill:safe-release",
      ),
    ).toEqual([]);
    expect(
      resolveActiveSkillBashAllows(
        {
          ...trusted,
          systemPromptOptions: { skills: [] },
        },
        "/skill:safe-release",
      ),
    ).toEqual([]);
  });

  test("keeps deny, substitution, and destructive ask floors above skill grants", async () => {
    const skill = await makeSkill("Bash(git -C * push *), Bash(bit *)");
    const allows = resolveActiveSkillBashAllows(
      eventFor("safe-release", skill.filePath, skill.markdown),
      "/skill:safe-release",
    );
    const rules = loadRules(undefined);

    expect(
      evaluateCommandWithSkillAllows(
        "git -C /tmp/project push -u origin branch",
        rules,
        allows,
      ).verdict,
    ).toBe("allow");
    expect(
      evaluateCommandWithSkillAllows(
        "git -C /tmp/project push -ofoo origin branch",
        rules,
        allows,
      ).verdict,
    ).toBe("allow");
    for (const command of [
      "git -C /tmp/project push --force origin branch",
      "git -C /tmp/project push --force-with-lease origin branch",
      "git -C/tmp/project push -f origin branch",
      "git -C '/tmp/project with spaces' push -vf origin branch",
      "git -C /tmp/project push -fu origin branch",
      "git -C /tmp/project push origin +main",
      "git -C /tmp/project push origin +HEAD:main",
      "git -C /tmp/project push --delete origin branch",
      "git -C /tmp/project push --del origin branch",
      "git -C /tmp/project push -vd origin branch",
      "git -C /tmp/project push origin :branch",
      "git -C /tmp/project push --mirror origin",
      "git -C /tmp/project push --mir origin",
      "git -C /tmp/project push --pru origin",
      "git -C /tmp/project push --exec=/tmp/payload origin branch",
      'git -C /tmp/project push --exec="$helper" origin branch',
      "git -C /tmp/project push --rec=/tmp/payload origin branch",
      'git -C /tmp/project push +"$ref"',
      "git -C /tmp/project push ext::payload HEAD",
      "git -C /tmp/project push --repo=helper::payload HEAD",
      "git -C /tmp/project --attr-source HEAD push --force origin branch",
      "git -C /tmp/project --future-option HEAD push --force origin branch",
    ]) {
      expect(
        evaluateCommandWithSkillAllows(command, rules, allows).verdict,
      ).toBe("ask");
    }
    expect(
      evaluateCommandWithSkillAllows(
        "git -C /tmp/project push -u origin branch && echo ungranted",
        rules,
        allows,
      ).verdict,
    ).toBe("ask");
    expect(
      evaluateCommandWithSkillAllows("bit relay sync", rules, allows).verdict,
    ).toBe("deny");
    expect(
      evaluateCommandWithSkillAllows(
        "git -C /tmp/project push -u origin $(bit relay sync)",
        rules,
        allows,
      ).verdict,
    ).toBe("deny");
  });

  test("keeps new structural and unavailable-project floors above skill grants", async () => {
    const upstream = await startJudge();
    const skill = await makeSkill(
      "Bash(bash *), Bash(cat *), Bash(echo *), Bash(curl *), Bash(git branch *), Bash(git pull *), Bash(git apply *)",
    );
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const allows = resolveActiveSkillBashAllows(event, "/skill:safe-release");
    const rules = loadRules(undefined);

    for (const command of [
      "bash -s <<< 'echo opaque'",
      '(cat) < "$HOME/.ssh/id_ed25519"',
      "echo hi >&1out",
      "curl --json x=y https://example.test/results",
      "curl --form-string x=y https://example.test/results",
      "git branch --del feature/context-judge",
    ]) {
      expect(
        evaluateCommandWithSkillAllows(command, rules, allows).verdict,
      ).toBe("ask");
    }

    const cwd = "/tmp/unverified-skill-project";
    const pi = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => ({
        kind: "unavailable",
        cwd,
        reason: "test discovery unavailable",
        fingerprint: "project:unavailable-skill",
      }),
    });
    await activateSkill(pi, event, "/skill:safe-release");

    const mutationCommands = ["git pull --ff-only", "git apply fix.patch"];
    for (const [index, command] of mutationCommands.entries()) {
      expect(
        await pi.emitToolCall(
          bashCall(command, `unavailable-skill-mutation-${index}`),
        ),
      ).toEqual({
        block: true,
        reason:
          "プロジェクト境界を検証できないため変更コマンドには確認が必要です",
      });
    }

    const verifiedCwd = "/tmp/verified-skill-project";
    const verifiedPi = createFakePi({ cwd: verifiedCwd, hasUI: false });
    setupPermissionPolicy(verifiedPi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => ({
        kind: "git",
        name: "verified",
        cwd: verifiedCwd,
        activeWorktree: verifiedCwd,
        navigableRoots: [verifiedCwd],
        worktrees: [verifiedCwd],
        fingerprint: "project:verified-skill",
      }),
    });
    await activateSkill(verifiedPi, event, "/skill:safe-release");
    for (const [index, command] of mutationCommands.entries()) {
      expect(
        await verifiedPi.emitToolCall(
          bashCall(command, `verified-skill-mutation-${index}`),
        ),
      ).toBeUndefined();
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("keeps Git reads and unverified rg residual despite active skill grants", async () => {
    const skill = await makeSkill("Bash(git status *), Bash(rg *)");
    const allows = resolveActiveSkillBashAllows(
      eventFor("safe-release", skill.filePath, skill.markdown),
      "/skill:safe-release",
    );
    const rules = loadRules(undefined);

    expect(
      evaluateCommandWithSkillAllows("git status --short", rules, allows)
        .verdict,
    ).toBe("default-continue");
    expect(
      evaluateCommandWithSkillAllows("rg pattern /etc/passwd", rules, allows)
        .verdict,
    ).toBe("default-continue");
  });

  test("does not let a git -C skill grant override helper-capable read risk", async () => {
    const upstream = await startJudge();
    const repositories = await makeGitRepositories();
    const skill = await makeSkill("Bash(git -C * status *)");
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const pi = createFakePi({ hasUI: false, cwd: repositories.root });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));
    await activateSkill(pi, event, "/skill:safe-release");

    expect(
      await pi.emitToolCall(
        bashCall(`git -C ${repositories.root} status --short`, "git-read"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("limits git -C push skill grants to the active repository", async () => {
    const upstream = await startJudge();
    const repositories = await makeGitRepositories();
    const skill = await makeSkill("Bash(git -C * push *)");
    const event = eventFor("safe-release", skill.filePath, skill.markdown);
    const pi = createFakePi({ hasUI: false, cwd: repositories.root });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));
    await activateSkill(pi, event, "/skill:safe-release");

    for (const [index, cwd] of [
      repositories.root,
      repositories.linked,
    ].entries()) {
      expect(
        await pi.emitToolCall(
          bashCall(
            `git -C ${cwd} push -u origin feature`,
            `same-repo-${index}`,
          ),
        ),
      ).toBeUndefined();
    }

    expect(
      await pi.emitToolCall(
        bashCall(
          `git -C ${repositories.unrelated} push -u origin feature`,
          "unrelated-repo",
        ),
      ),
    ).toMatchObject({ block: true });

    const escaped = join(repositories.root, "escaped-repository");
    await fs.symlink(repositories.unrelated, escaped, "dir");
    expect(
      await pi.emitToolCall(
        bashCall(`git -C ${escaped} push -u origin feature`, "symlink-escape"),
      ),
    ).toMatchObject({ block: true });
    expect(chatRequests(upstream)).toHaveLength(0);
  });

  test("the create-pr skill grants its worktree push form", () => {
    const filePath = join(
      import.meta.dir,
      "../../claude/.claude/skills/create-pr/SKILL.md",
    );
    const markdown = readFileSync(filePath, "utf8");
    const allows = resolveActiveSkillBashAllows(
      eventFor("create-pr", filePath, markdown),
      "/skill:create-pr",
    );

    expect(
      evaluateCommandWithSkillAllows(
        "git -C /tmp/worktree push -u origin fix/example",
        loadRules(undefined),
        allows,
      ).verdict,
    ).toBe("allow");
  });
});
