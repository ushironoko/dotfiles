import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import config from "../../dotfiles.config";

const PROMPT_PATH = resolve(import.meta.dir, "../../pi/APPEND_SYSTEM.md");

describe("global pi appended system prompt", () => {
  test("is deployed as a child file without replacing the agent directory", () => {
    expect(config.mappings).toContainEqual({
      source: "./pi/APPEND_SYSTEM.md",
      target: "~/.pi/agent/APPEND_SYSTEM.md",
      type: "file",
    });
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
