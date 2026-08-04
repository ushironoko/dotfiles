import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import config from "../../dotfiles.config";

const PROMPT_PATH = resolve(import.meta.dir, "../../pi/SYSTEM.md");

describe("global pi system prompt", () => {
  test("replaces the built-in prompt without replacing the agent directory", () => {
    expect(config.mappings).toContainEqual({
      source: "./pi/SYSTEM.md",
      target: "~/.pi/agent/SYSTEM.md",
      type: "file",
    });
    expect(
      config.mappings.some(({ source }) => source.includes("APPEND_SYSTEM")),
    ).toBe(false);
  });

  test("retains useful coding guidance without the pi documentation section", async () => {
    const prompt = await readFile(PROMPT_PATH, "utf8");

    expect(prompt).toContain("expert coding assistant operating inside pi");
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain(
      "Use read to examine files instead of cat or sed.",
    );
    expect(prompt).toContain("Use edit for precise changes");
    expect(prompt).toContain("Be concise in your responses.");
    expect(prompt).toContain(
      "Show file paths clearly when working with files.",
    );
    expect(prompt).not.toContain("Pi documentation");
    expect(prompt).not.toContain("@earendil-works/pi-coding-agent");
  });

  test("teaches agents to use the warmed Hearth graph efficiently", async () => {
    const prompt = await readFile(PROMPT_PATH, "utf8");

    expect(prompt).toContain("When `hearth_graph` is available");
    expect(prompt).toContain(
      "Successful `read` and `grep` calls warm its module index",
    );
    expect(prompt).toContain("read-only structural index");
    expect(prompt).toContain("comprehensive codebase exploration");
    expect(prompt).toContain("change-impact analysis");
    expect(prompt).toContain(
      "`symbols`, `outline`, `search`, and `definitions`",
    );
    expect(prompt).toContain("`deps`, `rdeps`, and `neighborhood`");
    expect(prompt).toContain("identify affected areas");
    expect(prompt).toContain("verify exact source with `read` before editing");
  });

  test("requires autonomous execution, retry, and complete reporting", async () => {
    const prompt = await readFile(PROMPT_PATH, "utf8");

    expect(prompt).toContain("the user is not monitoring live task progress");
    expect(prompt).toContain(
      "Use available workflows and subagents autonomously",
    );
    expect(prompt).toContain("perform that action now");
    expect(prompt).toContain(
      "Stop and ask the user only when progress depends",
    );
    expect(prompt).toContain("diagnose failures and retry");
    expect(prompt).toContain("Work outcome-first");
    expect(prompt).toContain("Prefer readable, well-structured communication");
    expect(prompt).toContain(
      "every completed deliverable and verification result",
    );
  });

  test("preserves the actual prompt hierarchy", async () => {
    const prompt = await readFile(PROMPT_PATH, "utf8");

    expect(prompt).toContain("higher-priority platform, system, developer");
    expect(prompt).toContain(
      "They override conflicting lower-priority guidance, not higher-priority instructions.",
    );
  });
});
