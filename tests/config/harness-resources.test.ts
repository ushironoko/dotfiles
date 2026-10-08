import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import settings from "../../claude/.claude/settings.json";
import config from "../../dotfiles.config";

const ROOT = resolve(import.meta.dir, "../..");
const MAINTAINED_ROLES = ["codex-poc", "codex-reviewer", "codex-runner"];
const RETIRED_ROLES = [
  "comment-reviewer",
  "rust-reviewer",
  "similarity",
  "tdd-reviewer",
];
const RETIRED_SKILLS = ["dig", "plan-review", "permission-audit-analysis"];
const SHARED_SKILLS = [
  "create-pr",
  "empirical-prompt-tuning",
  "html-to-svg",
  "octorus",
  "output-learn",
  "restoring-session",
  "smart-compact",
  "start-work",
  "write-session",
];

describe("maintained harness resources", () => {
  test("keeps Claude lifecycle adapters after retiring quality checks", () => {
    expect(settings.hooks).not.toHaveProperty("SessionStart");
    expect(settings.hooks).not.toHaveProperty("Stop");
    expect(
      settings.hooks.PostToolUse[0]?.hooks.map(({ command }) => command),
    ).toEqual([
      "~/.claude/hooks/post_tool_use/coding_cycle.sh",
      "~/.claude/hooks/post_tool_use/type_safety_check.sh",
    ]);
    expect(settings.hooks.TaskCompleted[0]?.hooks[0]?.command).toBe(
      "~/.claude/hooks/task-completed/bit-issue-update.sh",
    );
    expect(settings.hooks.Notification[0]?.hooks[0]?.command).toBe(
      "/Applications/asuku.app/Contents/MacOS/asuku-hook notification",
    );
  });

  test("disables Claude account skill synchronization", () => {
    expect(settings.syncClaudeAiSkills).toBe(false);
  });

  test("ignores downloaded and trashed skills without ignoring maintained sources", () => {
    const caches = [
      "claude/.claude/skills/synced/account/example/SKILL.md",
      "claude/.claude/skills/.trash/example/SKILL.md",
    ];
    const result = Bun.spawnSync(
      [
        "git",
        "check-ignore",
        "--no-index",
        "--",
        ...caches,
        "claude/.claude/skills/start-work/SKILL.md",
      ],
      { cwd: ROOT },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual(caches);
  });

  test("keeps exactly the maintained roles in both agent directories and mappings", async () => {
    for (const [directory, extension] of [
      ["claude/.claude/agents", ".md"],
      ["codex/agents", ".toml"],
    ]) {
      const entries = await readdir(resolve(ROOT, directory));
      expect(entries.sort()).toEqual(
        MAINTAINED_ROLES.map((name) => `${name}${extension}`).sort(),
      );
    }

    expect(
      config.mappings.find(({ target }) => target === "~/.codex/agents"),
    ).toEqual({
      source: "./codex/agents",
      target: "~/.codex/agents",
      type: "selective",
      include: MAINTAINED_ROLES.map((name) => `${name}.toml`),
    });
    const claudeMapping = config.mappings.find(
      ({ target }) => target === "~/.claude",
    );
    expect(claudeMapping?.source).toBe("./claude/.claude");
    expect(claudeMapping?.type).toBe("selective");
    expect(claudeMapping?.include).toContain("agents");
  });

  test("preserves native role identities and their write boundaries", async () => {
    for (const name of MAINTAINED_ROLES) {
      const claudeSource = await readFile(
        resolve(ROOT, "claude/.claude/agents", `${name}.md`),
        "utf8",
      );
      expect(claudeSource).toMatch(new RegExp(`^name: ${name}$`, "m"));
      const nativeRole = Bun.TOML.parse(
        await readFile(resolve(ROOT, "codex/agents", `${name}.toml`), "utf8"),
      ) as Record<string, unknown>;
      expect(nativeRole.name).toBe(name);
      expect(nativeRole.sandbox_mode).toBe(
        name === "codex-reviewer" ? "read-only" : "workspace-write",
      );
      expect(nativeRole.developer_instructions).toContain(
        "Do not invoke another Codex CLI process",
      );
    }
  });

  test("removes retired skill sources and preserves every maintained shared skill", () => {
    const mapping = config.mappings.find(
      ({ target }) => target === "~/.agents/skills",
    );
    expect(mapping).toEqual({
      source: "./claude/.claude/skills",
      target: "~/.agents/skills",
      type: "selective",
      include: SHARED_SKILLS,
    });
    for (const name of RETIRED_SKILLS) {
      expect(existsSync(resolve(ROOT, "claude/.claude/skills", name))).toBe(
        false,
      );
    }
    for (const name of SHARED_SKILLS) {
      expect(
        existsSync(resolve(ROOT, "claude/.claude/skills", name, "SKILL.md")),
      ).toBe(true);
    }
  });

  test("removes retired references from managed harness prompts, docs, and generation settings", async () => {
    const retiredReference = new RegExp(
      `\\b(?:${[...RETIRED_ROLES, ...RETIRED_SKILLS].join("|")})\\b`,
      "i",
    );
    const files = [
      "claude/.claude/CLAUDE.md",
      "codex/AGENTS.md",
      "codex/README.md",
      "pi/SYSTEM.md",
      "pi/README.md",
      "scripts/sync-codex-agents.ts",
      "dotfiles.config.ts",
      ...MAINTAINED_ROLES.flatMap((name) => [
        `claude/.claude/agents/${name}.md`,
        `codex/agents/${name}.toml`,
      ]),
    ];
    const references = await Promise.all(
      files.map(async (path) =>
        retiredReference.test(await readFile(resolve(ROOT, path), "utf8"))
          ? path
          : undefined,
      ),
    );
    expect(references.filter((path) => path !== undefined)).toEqual([]);
  });

  test("keeps generic review security without the retired Plan transport", async () => {
    const reviewer = await readFile(
      resolve(ROOT, "claude/.claude/agents/codex-reviewer.md"),
      "utf8",
    );
    for (const token of [
      "path-base64-v1",
      "plan-safe-path",
      "plan-path-base64",
      "path-only Plan",
      "encode-plan-path",
    ]) {
      expect(reviewer).not.toContain(token);
    }
    expect(reviewer).toContain("untrusted review data");
    expect(reviewer).toContain("codex-stage.sh");
    expect(reviewer).toContain("Never disable that");
    expect(reviewer).toContain("Codex sandbox or invoke `codex` directly");
  });

  test("generates only maintained roles and detects generated definition drift", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "harness-resources-"));
    const generator = "scripts/sync-codex-agents.ts";
    try {
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await mkdir(join(fixture, "claude/.claude/agents"), { recursive: true });
      await copyFile(resolve(ROOT, generator), join(fixture, generator));
      await Promise.all(
        MAINTAINED_ROLES.map((name) =>
          copyFile(
            resolve(ROOT, "claude/.claude/agents", `${name}.md`),
            join(fixture, "claude/.claude/agents", `${name}.md`),
          ),
        ),
      );
      const run = (...args: string[]) =>
        Bun.spawnSync([process.execPath, generator, ...args], {
          cwd: fixture,
        });
      const generated = run();
      expect(generated.stderr.toString()).toBe("");
      expect(generated.exitCode).toBe(0);
      const entries = await readdir(join(fixture, "codex/agents"));
      expect(entries.sort()).toEqual(
        MAINTAINED_ROLES.map((name) => `${name}.toml`).sort(),
      );
      for (const name of MAINTAINED_ROLES) {
        expect(
          await readFile(join(fixture, "codex/agents", `${name}.toml`), "utf8"),
        ).toBe(
          await readFile(resolve(ROOT, "codex/agents", `${name}.toml`), "utf8"),
        );
      }
      expect(run("--check").exitCode).toBe(0);
      const driftedPath = join(fixture, "codex/agents/codex-reviewer.toml");
      await writeFile(driftedPath, 'name = "drifted"\n');
      const drifted = run("--check");
      expect(drifted.exitCode).toBe(1);
      expect(drifted.stderr.toString()).toContain(
        "codex/agents/codex-reviewer.toml",
      );
      expect(await readFile(driftedPath, "utf8")).toBe('name = "drifted"\n');
      expect(run().exitCode).toBe(0);
      expect(run("--check").exitCode).toBe(0);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
