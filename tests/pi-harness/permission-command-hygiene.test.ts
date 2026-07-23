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
    expect(prompt).toContain("already captures stdout and stderr");
    expect(prompt).toContain(
      "Do not create a temporary file merely to inspect, filter, summarize",
    );
    expect(prompt).toContain("prefer the first applicable option");
    expect(prompt).toContain(
      "An available dedicated read, edit, or write tool",
    );
    expect(prompt).toContain("Never assume a tool exists");
    expect(prompt).toContain("native --summary, --format, or --json mode");
    expect(prompt).toContain("directly executable literal command");
    expect(prompt).toContain("stdout is genuinely the next command's stdin");
    expect(prompt).toContain("user requested a persistent artifact");
    expect(prompt).toContain(
      "native file option such as --body-file or --output",
    );
    expect(prompt).toContain("keep the path project-bounded");
    expect(prompt).toContain("one independently verifiable step");
    expect(prompt).toContain("sequentially as separate Bash calls");
    expect(prompt).toContain("inspect each result");
    expect(prompt).toContain("Do not batch unrelated work with ;, &&");
    expect(prompt).toContain(
      "Avoid >, >>, tee, $(<file), and /tmp intermediates",
    );
    expect(prompt).toContain(
      "literal filter and a project-relative input file",
    );
    expect(prompt).toContain(
      "do not use jq options that load additional files",
    );
    expect(prompt).toContain("long or multiline content passed to a CLI");
    expect(prompt).toContain("--body-file");
    expect(prompt).toContain("ANSI-C-quoted or escaped payload");
    expect(prompt).toContain("data file is not an ad-hoc executable script");
    expect(prompt).toContain("bun x, bunx, npx, or pnpm dlx");
    expect(prompt).toContain("bun run test are repository scripts");
    expect(prompt).toContain("bun run qualify:pi-permission-judge --summary");
    expect(prompt).toContain("bit issue update ID --body 'short literal body'");
    expect(prompt).toContain(
      "multiline bit issue body contains no single quote",
    );
    expect(prompt).toContain("literal newlines are allowed");
    expect(prompt).toContain(
      "bit issue create --title 'Task' --body 'line one\nline two'",
    );
    expect(prompt).toContain(
      "Do not synthesize the body with a heredoc, command substitution, or temporary file",
    );
    expect(prompt).toContain("rg --no-config ... | head -200");
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
