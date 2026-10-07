import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import config from "../../dotfiles.config";
import settings from "../../pi/settings.json";

const ROOT = resolve(import.meta.dir, "../..");
const RETIRED_PI_SKILLS = [
  "dig",
  "plan-review",
  "permission-audit-analysis",
] as const;

describe("Pi skill installation", () => {
  test("installs only the maintained dedicated skills", () => {
    const mapping = config.mappings.find(
      ({ target }) => target === "~/.pi/agent/skills",
    );
    expect(mapping).toEqual({
      source: "./pi/skills",
      target: "~/.pi/agent/skills",
      type: "selective",
      include: [
        "restoring-session",
        "smart-compact",
        "start-work",
        "write-session",
        "project-memory",
      ],
    });
    for (const skill of mapping?.include ?? []) {
      expect(existsSync(resolve(ROOT, "pi/skills", skill, "SKILL.md"))).toBe(
        true,
      );
    }
  });

  test("removes retired Pi sources and their documentation references", async () => {
    const readme = await readFile(resolve(ROOT, "pi/README.md"), "utf8");
    for (const skill of RETIRED_PI_SKILLS) {
      expect(existsSync(resolve(ROOT, "pi/skills", skill))).toBe(false);
      expect(readme).not.toMatch(new RegExp(`\\b${skill}\\b`));
    }
  });

  test("preserves shared Claude/Codex skills without exposing them to Pi", () => {
    const mapping = config.mappings.find(
      ({ target }) => target === "~/.agents/skills",
    );
    for (const skill of ["start-work", "restoring-session", "write-session"]) {
      expect(mapping?.include).toContain(skill);
      expect(
        existsSync(resolve(ROOT, "claude/.claude/skills", skill, "SKILL.md")),
      ).toBe(true);
    }
    expect(settings.skills).toContain("!/Users/ushironoko/.agents/skills/**");
  });
});
