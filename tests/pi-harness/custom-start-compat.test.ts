import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupHookBridge from "../../pi/extensions/pi-harness/features/hook-bridge";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import { COMMAND_HYGIENE_GUIDANCE } from "../../pi/extensions/pi-harness/features/permission-policy/command-hygiene";
import { resolveActiveSkillBashAllows } from "../../pi/extensions/pi-harness/features/permission-policy/skill-allow";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { BeforeAgentStartEvent } from "../../pi/extensions/pi-harness/lib/pi-like";
import { createFakePi } from "./fake-pi";

const temporaryDirectories: string[] = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-custom-start-"));
  temporaryDirectories.push(directory);
  return directory;
};

const makeConfig = (directory: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: false,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(directory),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("custom-message agent starts", () => {
  test("keeps legacy user hooks but skips custom-message prompt hooks", async () => {
    const directory = await makeDirectory();
    const script = join(directory, "prompt-hook.sh");
    await writeFile(
      script,
      '#!/bin/sh\nprintf invoked >> "$0.calls"\nprintf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"user hook context"}}\'\n',
      { mode: 0o755 },
    );
    const pi = createFakePi({ cwd: directory });
    setupHookBridge(pi, makeConfig(directory), {
      registry: [
        {
          id: "custom-start-test",
          stage: "before_agent_start",
          script,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        },
      ],
    });

    const user = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "a legacy user prompt",
    });
    expect(user?.message?.content).toBe("user hook context");
    const custom = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      messageType: "custom",
      message: { customType: "internal", content: "continue", display: false },
    });
    expect(custom).toBeUndefined();
    expect(await readFile(`${script}.calls`, "utf8")).toBe("invoked");
  });

  test("clears active user skill grants before a custom-message run", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "SKILL.md");
    const body = "Push the reviewed branch.";
    await writeFile(
      filePath,
      `---\nname: safe-release\ndescription: test skill\nallowed-tools: Bash(git push *)\n---\n\n${body}\n`,
    );
    const prompt = `<skill name="safe-release" location="${filePath}">\nReferences are relative to ${directory}.\n\n${body}\n</skill>`;
    const systemPromptOptions = {
      skills: [
        {
          name: "safe-release",
          description: "test skill",
          filePath,
          baseDir: directory,
        },
      ],
    };
    const pi = createFakePi({ cwd: directory, hasUI: false });
    setupPermissionPolicy(pi, makeConfig(directory));
    await pi.emitInput({
      type: "input",
      text: "/skill:safe-release",
      source: "interactive",
    });
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      messageType: "user",
      prompt,
      systemPromptOptions,
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
    ];
    await pi.emitContext(messages);
    const push = (toolCallId: string) => ({
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId,
      input: { command: "git push origin reviewed" },
    });
    expect(await pi.emitToolCall(push("before-custom"))).toBeUndefined();

    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      messageType: "custom",
      message: { customType: "internal", content: prompt, display: false },
      systemPrompt: "base",
      systemPromptOptions,
    };
    const custom = await pi.emitBeforeAgentStart(event);
    expect(custom?.systemPrompt).toContain(COMMAND_HYGIENE_GUIDANCE);
    expect(custom?.systemPrompt).toContain("base");
    expect(resolveActiveSkillBashAllows(event, "/skill:safe-release")).toEqual(
      [],
    );
    expect(await pi.emitToolCall(push("after-custom"))).toMatchObject({
      block: true,
    });
    await pi.emitContext(messages);
    expect(await pi.emitToolCall(push("after-custom-context"))).toMatchObject({
      block: true,
    });
  });
});
