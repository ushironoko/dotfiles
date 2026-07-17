import { describe, expect, test } from "bun:test";
import {
  findPermissionRuleDrift,
  type ClaudePermissionSettings,
  type PiPermissionRules,
} from "../../scripts/check-pi-rules";

const settings: ClaudePermissionSettings = {
  permissions: {
    allow: ["Bash(bun:*)", "Read(**)"],
    deny: ["Bash(bit relay:*)"],
  },
};

const rules: PiPermissionRules = {
  allow: [{ source: "Bash(bun:*)" }],
  deny: [{ source: "Bash(bit relay:*)" }],
};

describe("check-pi-rules", () => {
  test("compares Bash allow and deny sources while ignoring non-Bash entries", () => {
    expect(findPermissionRuleDrift(settings, rules)).toEqual({
      missing: [],
      stale: [],
      duplicates: [],
      wrongBucket: [],
    });
  });

  test("reports missing and stale sources bidirectionally", () => {
    expect(
      findPermissionRuleDrift(settings, {
        allow: [{ source: "Bash(pnpm:*)" }],
        deny: [],
      }),
    ).toEqual({
      missing: ["allow:Bash(bun:*)", "deny:Bash(bit relay:*)"],
      stale: ["allow:Bash(pnpm:*)"],
      duplicates: [],
      wrongBucket: [],
    });
  });

  test("reports wrong buckets and duplicate source metadata", () => {
    const drift = findPermissionRuleDrift(settings, {
      allow: [
        { source: "Bash(bun:*)" },
        { source: "Bash(bun:*)" },
        { source: "Bash(bit relay:*)" },
      ],
      deny: [],
    });

    expect(drift.duplicates).toEqual(["allow:Bash(bun:*)"]);
    expect(drift.wrongBucket).toEqual(["deny:Bash(bit relay:*)"]);
  });
});
