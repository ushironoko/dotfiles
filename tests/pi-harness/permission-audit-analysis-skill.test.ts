import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SKILL = join(ROOT, "pi/skills/permission-audit-analysis/SKILL.md");
const REFERENCE = join(
  ROOT,
  "pi/skills/permission-audit-analysis/references/corpus-review.md",
);

describe("permission audit analysis skill", () => {
  test("declares a discoverable body-free analysis workflow", async () => {
    const text = await readFile(SKILL, "utf8");
    expect(text).toContain("name: permission-audit-analysis");
    expect(text).toMatch(
      /description:.*Analyze private pi-harness Bash permission audit logs/,
    );
    expect(text).toContain("bun <skill-dir>/scripts/analyze.ts summary");
    expect(text).toContain("bun <skill-dir>/scripts/analyze.ts top-ask");
    expect(text).toContain("Start with body-free `summary`");
    expect(text).toContain("`summary` is a prerequisite for `top-ask`");
    expect(text).toMatch(/not read raw JSONL files/);
    expect(text).toContain("every retained record");
    expect(text).toContain('Do not silently interpret "recent"');
    expect(text).toContain("--since <timestamp>");
    expect(text).toContain("rolling duration");
    expect(text).toContain(
      "Never infer command meaning or user intent from a hash",
    );
    expect(text).toMatch(/never report skipped\s+file names or paths/);
    expect(text).toContain("Never fabricate analyzer values");
    expect(text).toContain("procedure-only plan");
    expect(text).toContain("shell-escaped");
    expect(text).toContain("00:00:00Z");
    expect(text).toContain("reason-code counts");
    expect(text).toContain("return to the same period gate");
    expect(text).toContain("user-requested later attempt uses");
    expect(text).toContain("scope.fileDiagnostics");
  });

  test("requires explicit disclosure and export approval", async () => {
    const text = await readFile(SKILL, "utf8");
    expect(text).toContain("bun <skill-dir>/scripts/analyze.ts locate");
    expect(text).toContain("`inspect` requires the selected `--decision-id`");
    expect(text).toContain("--record-sha256 <digest-from-locate>");
    expect(text).toContain("--match-count <count-from-locate>");
    expect(text).toContain("--show-sensitive");
    expect(text).toContain("--include-sensitive");
    expect(text).toContain("current model/provider");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("Every `AskUserQuestion` call must be made alone");
    expect(text).toMatch(/actual current\s+provider\/model/);
    expect(text).toContain("Never inspect another decision ID or hash");
    expect(text).toContain("starts from `locate`");
    expect(text).toContain("match count changed");
    expect(text).toContain("Re-resolve the");
    expect(text).toContain("exactly equals an ID returned by `locate`");
    expect(text).toContain("permission-candidates-<UTC timestamp>.jsonl");
    expect(text).toContain("permission-reviewed-<UTC timestamp>.jsonl");
    expect(text).toContain("show the exact expanded path");
    expect(text).toContain("never overwrite or silently redirect");
    expect(text).toContain("candidateSha256");
    expect(text).toContain("--candidate-sha256");
    expect(text).toContain("candidate bytes still match");
    expect(text).toContain("current-user `0700`");
    expect(text).toContain("Call `AskUserQuestion` alone to approve export");
    expect(text).toContain("date -u +%Y%m%dT%H%M%SZ");
    expect(text).toContain("narrow exception only");
    expect(text).toContain("Never evaluate `$()`");
    expect(text).toContain("one inert");
  });

  test("keeps corpus labels human-only and promotion separate", async () => {
    const [skill, reference] = await Promise.all([
      readFile(SKILL, "utf8"),
      readFile(REFERENCE, "utf8"),
    ]);
    expect(skill).toContain(
      "Do not read the candidate file into the agent context",
    );
    expect(skill).toContain("--confirm-human-labels");
    expect(skill).toMatch(
      /general-purpose `Read` tool must not read\s+candidate or labels content/,
    );
    expect(skill).toContain("do not recompute or replace the ticket");
    expect(skill).toContain("STOP_WAITING_FOR_HUMAN_LABELS");
    expect(skill).toMatch(/Only the\s+approved local analyzer may read them/);
    expect(skill).toContain(
      "No analyzer command or approval question is retried",
    );
    expect(skill).toContain('labelSource: "human-review"');
    expect(skill).toContain(
      "Never generate a label without a human-created labels file",
    );
    expect(skill).toContain("Never automatically edit permission rules");
    expect(skill).toContain("start a separate `start-work` task");
    expect(reference).toContain("Permission audit records are observations");
    expect(reference).toContain(
      "When deciding between `allow` and `ask`, choose `ask`",
    );
    expect(reference).toContain("Do not paste it into chat");
    expect(reference).toContain("candidateSha256");
    expect(reference).toContain("changed after human");
    expect(reference).toContain("do not ask the agent to read its contents");
    expect(reference).toContain("never accept a recomputed digest");
    expect(reference).toMatch(/set\s+the file to `0600`/);
    expect(reference).toContain("human-reviewed staging corpus");
    expect(reference).toContain("select and sanitize");
  });

  test("is selectively installed and documented as a pi-only skill", async () => {
    const [config, readme] = await Promise.all([
      readFile(join(ROOT, "dotfiles.config.ts"), "utf8"),
      readFile(join(ROOT, "pi/README.md"), "utf8"),
    ]);
    expect(config).toContain('"permission-audit-analysis"');
    expect(readme).toContain("permission-audit-analysis");
    expect(readme).toContain("body-free");
    expect(readme).toContain("human-reviewed");
  });
});
