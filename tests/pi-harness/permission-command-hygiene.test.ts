import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import {
  appendCommandHygiene,
  COMMAND_HYGIENE_GUIDANCE,
} from "../../pi/extensions/pi-harness/features/permission-policy/command-hygiene";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";

const makeConfig = (isChild: boolean): HarnessConfig => ({
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
  paths: resolvePaths("/tmp/pi-permission-command-hygiene"),
});

describe("permission command hygiene prompt", () => {
  test("states a soft priority order with an explicit capability escape hatch", () => {
    const prompt = appendCommandHygiene("BASE SYSTEM PROMPT\n");

    expect(prompt).toStartWith("BASE SYSTEM PROMPT\n\n");
    expect(prompt).toContain("preference, not a hard constraint");
    expect(prompt).toContain("dedicated read, edit, and write tools");
    expect(prompt).toContain("directly executable literal commands");
    expect(prompt).toContain("one independently verifiable step");
    expect(prompt).toContain("sequentially as separate Bash calls");
    expect(prompt).toContain("inspect each result");
    expect(prompt).toContain("Do not batch unrelated work with ;, &&");
    expect(prompt).toContain("stdout is genuinely the next command's input");
    expect(prompt).toContain("pipeline is not a substitute");
    expect(prompt).toContain("long or multiline content passed to a CLI");
    expect(prompt).toContain("--body-file");
    expect(prompt).toContain("ANSI-C-quoted or escaped payload");
    expect(prompt).toContain("data file is not an ad-hoc executable script");
    expect(prompt).toContain("bun x, bunx, npx, or pnpm dlx");
    expect(prompt).toContain("bun run test are repository scripts");
    expect(prompt).toContain("rg --no-config");
    expect(prompt).toContain("first state briefly why it is needed");
    expect(prompt).toContain("instead of merely claiming that it is safe");
    expect(prompt).toContain(
      "Do not compress complex work into a fragile one-liner",
    );
    expect(COMMAND_HYGIENE_GUIDANCE).not.toContain("never use Bash");
  });

  test.each([false, true])(
    "chains system-only guidance in the parent/child profile (isChild=%s)",
    async (isChild) => {
      const pi = createFakePi();
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt ?? ""}\n\nEARLIER GUIDANCE`,
      }));
      setupPermissionPolicy(pi, makeConfig(isChild));

      const result = await pi.emitBeforeAgentStart({
        type: "before_agent_start",
        prompt: "Inspect the permission policy",
        systemPrompt: "BASE SYSTEM PROMPT",
      });

      expect(result?.message).toBeUndefined();
      expect(result?.systemPrompt).toStartWith(
        "BASE SYSTEM PROMPT\n\nEARLIER GUIDANCE\n\n",
      );
      expect(result?.systemPrompt).toEndWith(COMMAND_HYGIENE_GUIDANCE);
    },
  );
});
