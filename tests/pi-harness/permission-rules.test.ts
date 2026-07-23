import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import {
  evaluateCommand,
  gitReadCwdTarget,
  hasProjectSensitiveMutation,
  hasUnverifiedProjectMutationNavigation,
  loadRules,
} from "../../pi/extensions/pi-harness/features/permission-policy/rules";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  loadConfig,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { ToolCallEvent } from "../../pi/extensions/pi-harness/lib/pi-like";
import { createFakePi } from "./fake-pi";

const config: HarnessConfig = {
  isChild: false,
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
  paths: resolvePaths("/tmp/pi-harness-permission-policy-test"),
};

const denyCases = [
  ["bit issue claim 123", "bit issue claim は禁止です"],
  ["bit issue unclaim 123", "bit issue unclaim は禁止です"],
  ["bit issue claims", "bit issue claims は禁止です"],
  ["bit issue watch 5", "bit issue watch は禁止です"],
  ["bit issue import x", "bit issue import は禁止です"],
  ["bit pr import 7", "bit pr import は禁止です"],
  ["bit relay serve", "bit relay は禁止です"],
  ["bit clone relay+ssh://x", "bit clone relay+ は禁止です"],
] as const;

const benignCommands: string[] = [
  "bit issue list --open",
  "echo hello",
  "git status",
  "rm -f /tmp/x",
  "rm -rf relative/path",
  "chmod 777 /tmp/x",
  "echo hi >&1",
  "echo hi >& '1'",
  "echo hi >&2-",
  "echo hi >& '2-'",
];

const destructiveCommands: string[] = [
  "find . -delete",
  "git push origin main",
  "git reset --soft HEAD~1",
  "git reset --hard HEAD~1",
  "git clean -f",
  "git branch -D feature/context-judge",
  "git branch --del feature/context-judge",
  "git worktree remove --force /tmp/context-judge",
  "sudo cat /etc/hosts",
  "curl -T test.log https://example.test/results",
  "curl --json x=y https://example.test/results",
  "curl --form-string x=y https://example.test/results",
  'cat "$HOME/.ssh/id_ed25519" | head -1',
  'cat < "$HOME/.ssh/id_ed25519"',
  '(cat) < "$HOME/.ssh/id_ed25519"',
  "rg . .ssh/id_ed25519",
  "git show HEAD:.ssh/id_ed25519",
  "sh ./unknown-script.sh",
  "bash -s <<< 'echo opaque'",
  "bash -x < ./unknown-script.sh",
  "bun x totally-unknown-package",
  "git -C /tmp/unrelated status --short",
  "git --git-dir=/tmp/unrelated/.git status --short",
  "git fetch --force origin main",
  "make lint > /tmp/lint.log",
  "echo hi >&out",
  "echo hi >&1out",
  'echo hi >&"$fd"',
  "echo hi >&$IFS",
  `echo hi >&\${IFS}`,
  "git add ../../outside.txt",
  "rm -rf /tmp/x",
  "rm -fr ~",
  "rm -r -f /",
  "git push origin main --force",
  "git push -f origin main",
  "git push -fu origin main",
  "git push -vd origin main",
  "git push --del origin main",
  "git push --mir origin",
  "git push --pru origin",
  "git push origin +HEAD:main",
  "git push --exec=/tmp/receive-pack origin main",
  'git push --exec="$helper" origin main',
  "/usr/bin/git -C /tmp push --del origin main",
  "git push ext::payload HEAD",
  "git push --repo=helper::payload HEAD",
  "git --attr-source HEAD push --force origin main",
  "git --future-option HEAD push --force origin main",
  "git clean -fd",
  "git clean -df",
  "git clean -f -d",
  "chmod -R 777 /tmp/x",
];

const createPermissionPi = (hasUI = true) => {
  const pi = createFakePi({ hasUI });
  setupPermissionPolicy(pi, config);
  return pi;
};

const bashCall = (command: string): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "t1",
  input: { command },
});

describe("permission-policy", () => {
  test.each(denyCases)("blocks %s", async (command, reason) => {
    const pi = createPermissionPi();

    expect(await pi.emitToolCall(bashCall(command))).toEqual({
      block: true,
      reason,
    });
  });

  test.each(benignCommands)("continues %s", async (command) => {
    const pi = createPermissionPi();

    expect(await pi.emitToolCall(bashCall(command))).toBeUndefined();
  });

  test.each(destructiveCommands)(
    "continues explicitly confirmed %s",
    async (command) => {
      const pi = createPermissionPi();
      pi.queueConfirm(true);

      expect(await pi.emitToolCall(bashCall(command))).toBeUndefined();
    },
  );

  test.each(destructiveCommands)("blocks unconfirmed %s", async (command) => {
    const pi = createPermissionPi();
    pi.queueConfirm(false);

    expect(await pi.emitToolCall(bashCall(command))).toEqual({
      block: true,
      reason: expect.any(String),
    });
  });

  test("blocks destructive commands without consulting confirm when non-interactive", async () => {
    const pi = createPermissionPi(false);
    pi.queueConfirm(true);

    expect(await pi.emitToolCall(bashCall("git reset --hard HEAD~1"))).toEqual({
      block: true,
      reason: expect.any(String),
    });

    pi.ctx.hasUI = true;
    expect(
      await pi.emitToolCall(bashCall("git reset --hard HEAD~1")),
    ).toBeUndefined();
  });

  test("passes through non-bash tools", async () => {
    const pi = createPermissionPi();

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "t1",
        input: { command: "bit issue claim x" },
      }),
    ).toBeUndefined();
  });

  // Malformed bash input must BLOCK, not pass through — the safety floor is
  // fail-closed for anything it cannot evaluate (review finding).
  test.each([
    { label: "non-string command", input: { command: 42 } },
    { label: "missing command", input: {} },
    { label: "null command", input: { command: null } },
    { label: "array command", input: { command: ["bit", "issue", "claim"] } },
  ])("blocks malformed bash input: $label", async ({ input }) => {
    const pi = createPermissionPi();

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "t1",
        input: input as Record<string, unknown>,
      }),
    ).toEqual({ block: true, reason: expect.stringContaining("ブロック") });
  });

  test("empty-but-valid rules file keeps the built-in deny floor", async () => {
    // A config of {"deny":[],"ask":[]} must not drop the mandatory denials.
    const { loadRules, evaluateCommand } = await import(
      "../../pi/extensions/pi-harness/features/permission-policy/rules"
    );
    const rules = loadRules('{"deny":[],"ask":[]}');
    expect(evaluateCommand("bit issue claim 123", rules).verdict).toBe("deny");
    expect(evaluateCommand("bit relay serve", rules).verdict).toBe("deny");
  });
});

describe("built-in read-only classification", () => {
  const rules = loadRules('{"deny":[],"allow":[],"ask":[]}');

  test("allows bounded absolute, missing, globbed, and null-sink rg operands", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-rg-read-"));
    const root = join(base, "project");
    const src = join(root, "src");
    const declarations = join(root, "declarations");
    const escapedDeclarations = join(root, "escaped-declarations");
    const dotglobDeclarations = join(root, "dotglob-declarations");
    const newlineDeclarations = join(root, "newline-declarations");
    const optionGlobCwd = join(root, "option-glob-cwd");
    const linked = join(base, "linked-worktree");
    const outside = join(base, "outside.txt");
    try {
      await Promise.all([
        mkdir(src, { recursive: true }),
        mkdir(declarations, { recursive: true }),
        mkdir(escapedDeclarations, { recursive: true }),
        mkdir(dotglobDeclarations, { recursive: true }),
        mkdir(newlineDeclarations, { recursive: true }),
        mkdir(optionGlobCwd, { recursive: true }),
        mkdir(linked, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(src, "a.ts"), "const value = 1;\n", "utf8"),
        writeFile(join(root, "root.d.ts"), "export {};\n", "utf8"),
        writeFile(join(declarations, "safe.d.ts"), "export {};\n", "utf8"),
        writeFile(join(optionGlobCwd, "safe.ts"), "export {};\n", "utf8"),
        writeFile(join(optionGlobCwd, "-L"), "not an option\n", "utf8"),
        writeFile(join(optionGlobCwd, "--pre=sh"), "not an option\n", "utf8"),
        writeFile(join(linked, "linked.ts"), "export {};\n", "utf8"),
        writeFile(outside, "secret\n", "utf8"),
      ]);
      await symlink(outside, join(root, "outside-link"));
      await symlink(outside, join(escapedDeclarations, "escape.d.ts"));
      await symlink(outside, join(dotglobDeclarations, ".escape.d.ts"));
      await symlink(outside, join(newlineDeclarations, "escape\n.d.ts"));
      const canonicalRoot = realpathSync(root);
      const canonicalLinked = realpathSync(linked);
      const options = {
        trustedReadContext: {
          cwd: canonicalRoot,
          navigableRoots: [canonicalRoot, canonicalLinked],
        },
      };

      for (const command of [
        "rg --no-config pattern",
        "rg --no-config -n pattern src",
        "rg --no-config -n pattern missing",
        `rg --no-config -n pattern ${src}`,
        `rg --no-config -n pattern ${join(linked, "linked.ts")}`,
        `rg --no-config -n pattern ${declarations}/*.d.ts`,
        `rg --no-config -n pattern ${src} ${join(root, "types")} ${root}/*.d.ts 2>/dev/null`,
        "rg --no-config -n --hidden pattern . --glob '!node_modules' | head -200",
      ]) {
        expect(evaluateCommand(command, rules, options).verdict).toBe("allow");
      }
      for (const command of [
        "rg pattern src",
        "rg --no-config pattern outside-link",
        "rg --no-config pattern outside-link/missing",
        `rg --no-config pattern ${outside}`,
        `rg --no-config pattern ${escapedDeclarations}/*.d.ts`,
        `rg --no-config pattern ${dotglobDeclarations}/*.d.ts`,
        `rg --no-config pattern ${newlineDeclarations}/*.d.ts`,
        'rg --no-config pattern src/*"$suffix"',
        "rg --no-config pattern s*/a.ts",
        "rg --no-config pattern src/?.ts",
        "rg --no-config pattern ../outside.txt",
        "rg --no-config --file=/tmp/patterns src",
        "rg --no-config --ignore-file=/tmp/ignore pattern src",
        "rg --no-config -f../patterns src",
        "rg --no-config pattern src < /dev/null",
      ]) {
        expect(evaluateCommand(command, rules, options).verdict).toBe(
          "default-continue",
        );
      }
      const optionGlobOptions = {
        trustedReadContext: {
          cwd: realpathSync(optionGlobCwd),
          navigableRoots: [canonicalRoot],
        },
      };
      expect(
        evaluateCommand("rg --no-config pattern *", rules, optionGlobOptions)
          .verdict,
      ).toBe("ask");
      expect(
        evaluateCommand(
          "rg --no-config pattern *",
          loadRules('{"deny":[],"allow":[{"pattern":"^"}],"ask":[]}'),
          optionGlobOptions,
        ).verdict,
      ).toBe("ask");
      expect(
        evaluateCommand(
          "rg --no-config pattern src > /tmp/results",
          rules,
          options,
        ).verdict,
      ).toBe("ask");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("neutralizes only a prevalidated git -C helper-capable read", () => {
    for (const command of [
      "git -C /repo status --short",
      "git -C/repo diff --stat",
      "git --no-pager -C /repo log -1 --oneline",
      "git -C /repo show --stat HEAD",
    ]) {
      expect(gitReadCwdTarget(command)).toBe("/repo");
      expect(evaluateCommand(command, rules).verdict).toBe("ask");
      expect(
        evaluateCommand(command, rules, {
          trustedGitCwdTarget: "/repo",
        }).verdict,
      ).toBe("default-continue");
    }

    for (const command of [
      "git -C /repo status --help",
      "git -C /repo diff --ext-diff",
      "git -C /repo config --list",
      "git -C /repo push origin main",
      "git -C /repo -C /other status --short",
      'git -C "$repo" status --short',
      "git -C ~/other status --short",
      "git -C /repo/link/.. status --short",
      "git -C ../repo status --short",
      "/usr/bin/git -C /repo status --short",
      "git -C /repo status --short && echo done",
      "git -C /repo status --short 2>/dev/null",
      "git --git-dir=/repo/.git status --short",
    ]) {
      expect(gitReadCwdTarget(command)).toBeUndefined();
    }
    expect(
      evaluateCommand("git -c color.ui=false status --short", rules, {
        trustedGitCwdTarget: "/repo",
      }).verdict,
    ).toBe("ask");
  });

  test.each([
    "rg --pre=cat pattern src",
    "rg --hostname-bin=sh pattern src",
    "rg -z pattern src",
    "rg -L pattern src",
    "rg -nL pattern src",
    "rg --follow pattern src",
    "git diff --ext-diff",
    "git log --textconv -1",
    "git diff --output=/tmp/project.diff",
    "git -p status",
    "git --paginate log -1",
    "git --bare status",
    "git status --help",
    "git help status",
    "git log -1 -p --ext-diff --format='%h %s' -- src/a.ts && git status --short --branch",
    "git log -1 --format='%h %s' -- src/a.ts > /tmp/log && git status --short --branch",
    "git -c log.showSignature=true log -1 --format='%h %s' -- src/a.ts && git status --short --branch",
    "git -C /tmp/unrelated log -1 --format='%h %s' -- src/a.ts && git status --short --branch",
    "git log -1 --format='%h %s' -- src/a.ts && git status --short --branch && git reset --hard",
  ])(
    "asks before a read option that can execute, escape, or write: %s",
    (command) => {
      expect(evaluateCommand(command, rules).verdict).toBe("ask");
    },
  );

  test.each([
    "git status --short",
    "git --no-pager show --stat --summary HEAD",
    "git log -1 --format='%h %s' -- src/a.ts && git status --short --branch",
    "/usr/bin/rg pattern src",
    "command rg pattern src",
    'rg "$pattern" src',
    "rg pattern /etc/passwd",
    "rg pattern ../unrelated",
    "git diff --no-index src/a.ts /tmp/a.ts",
    "head /etc/passwd",
    "head -n 20",
    "head -- -secret",
  ])(
    "leaves helper-capable, non-literal, or file-reading variants to the judge: %s",
    (command) => {
      expect(evaluateCommand(command, rules).verdict).toBe("default-continue");
    },
  );

  test("keeps helper-capable Git and unverified rg residual despite a broad allow", () => {
    const broadAllow = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^(?:git|rg)\\s" }],
        ask: [],
      }),
    );
    const cwd = resolve(import.meta.dir, "../..");
    const options = {
      trustedReadContext: { cwd, navigableRoots: [cwd] },
    };

    for (const command of [
      "git status --short",
      "git diff --stat",
      "git log -1 --oneline",
      "git show --stat HEAD",
      "rg pattern tests",
      "rg --no-config pattern /etc/passwd",
    ]) {
      expect(evaluateCommand(command, broadAllow, options).verdict).toBe(
        "default-continue",
      );
    }
    for (const command of [
      "rg --no-config pattern tests",
      "rg --no-config pattern missing",
    ]) {
      expect(evaluateCommand(command, broadAllow, options).verdict).toBe(
        "allow",
      );
    }
  });

  test("lets a configured ask override a verified built-in read-only allow", () => {
    const askRules = loadRules(
      String.raw`{"deny":[],"allow":[],"ask":[{"pattern":"^rg\\s","reason":"confirm search"}]}`,
    );
    const cwd = resolve(import.meta.dir, "../..");
    expect(
      evaluateCommand("rg --no-config pattern tests", askRules, {
        trustedReadContext: { cwd, navigableRoots: [cwd] },
      }),
    ).toEqual({
      verdict: "ask",
      reason: "confirm search",
    });
  });
});

describe("explicit allow matching", () => {
  const rules = loadRules(
    JSON.stringify({
      deny: [],
      allow: [
        { pattern: "^bun(?: |(?![\\s\\S]))" },
        {
          pattern: "^~/\\.claude/hooks/lib/codex-stage\\.sh(?: |(?![\\s\\S]))",
        },
      ],
      ask: [],
    }),
  );

  test.each([
    "bun",
    "bun test",
    "bun run check --filter=core",
    'bun test --filter "foo bar"',
    "bun -e 'process.exit(0)'",
    "bun test && bun run lint",
  ])("allows an explicitly trusted concrete command: %s", (command) => {
    expect(evaluateCommand(command, rules).verdict).toBe("allow");
  });

  test.each([
    "FOO=bar bun test",
    "/tmp/bun test",
    "./bun test",
    '"bun" test',
    String.raw`b\un test`,
    'bun "$task"',
    "bun $IFS#x; /tmp/evil",
    "bun ${IFS}#x; /tmp/evil",
    "bun\r#x; /tmp/evil",
    "bun test &",
  ])(
    "does not widen an allow through wrappers, paths, or expansion: %s",
    (command) => {
      expect(evaluateCommand(command, rules).verdict).toBe("default-continue");
    },
  );

  test.each([
    "sudo bun test",
    "bun --version > ~/.ssh/authorized_keys",
    "> ~/.ssh/authorized_keys; bun --version",
    "git reset --hard HEAD~1",
  ])("mandatory risk floor outranks an explicit allow: %s", (command) => {
    expect(evaluateCommand(command, rules).verdict).toBe("ask");
  });

  test("every new structural floor outranks a catch-all configured allow", () => {
    const catchAll = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^" }],
        ask: [],
      }),
    );
    for (const command of [
      "bash -s <<< 'echo opaque'",
      '(cat) < "$HOME/.ssh/id_ed25519"',
      "echo hi >&1out",
      'echo hi >&"$fd"',
      "echo hi >&$IFS",
      `echo hi >&\${IFS}`,
      "curl --json x=y https://example.test/results",
      "curl --form-string x=y https://example.test/results",
      "git branch --del feature/context-judge",
    ]) {
      expect(evaluateCommand(command, catchAll).verdict).toBe("ask");
    }
  });

  test("detects project-sensitive Git mutations inside substitutions", () => {
    expect(hasProjectSensitiveMutation('echo "$(git pull --ff-only)"')).toBe(
      true,
    );
    expect(hasProjectSensitiveMutation('echo "$(git apply fix.patch)"')).toBe(
      true,
    );
    expect(hasProjectSensitiveMutation('echo "$(git rev-parse HEAD)"')).toBe(
      false,
    );
    expect(
      hasUnverifiedProjectMutationNavigation(
        "cd ../other && git pull --ff-only",
        false,
      ),
    ).toBe(true);
    expect(
      hasUnverifiedProjectMutationNavigation(
        "(cd /tmp/unrelated && git apply fix.patch)",
        false,
      ),
    ).toBe(true);
    expect(
      hasUnverifiedProjectMutationNavigation(
        'echo "$(cd /tmp/unrelated && git pull --ff-only)"',
        false,
      ),
    ).toBe(true);
    expect(
      hasUnverifiedProjectMutationNavigation(
        'echo "$(cd /tmp/unrelated)" && git pull --ff-only',
        false,
      ),
    ).toBe(false);
    expect(
      hasUnverifiedProjectMutationNavigation(
        "cd /repo/worktree && git pull --ff-only",
        true,
      ),
    ).toBe(false);
    expect(
      hasUnverifiedProjectMutationNavigation(
        "cd /repo/worktree && pushd /tmp/unrelated && git pull --ff-only",
        true,
      ),
    ).toBe(true);
  });

  test("neutralizes only a prevalidated leading absolute cd for allow aggregation", () => {
    const target = "/repo/worktree";
    expect(
      evaluateCommand(`cd ${target} && bun run tsc`, rules, {
        trustedLeadingCdTarget: target,
      }).verdict,
    ).toBe("allow");
    expect(
      evaluateCommand(`cd '${target} with space' && bun test`, rules, {
        trustedLeadingCdTarget: `${target} with space`,
      }).verdict,
    ).toBe("allow");
  });

  test.each([
    "cd relative/path && bun test",
    "cd /repo/worktree; bun test",
    "cd /repo/worktree || bun test",
    "cd /repo/worktree | bun test",
    "(cd /repo/worktree && bun test)",
    "cd /repo/worktree && cd /repo/worktree/sub && bun test",
    'cd "$target" && bun test',
  ])("does not widen trusted cd through another shell shape: %s", (command) => {
    expect(
      evaluateCommand(command, rules, {
        trustedLeadingCdTarget: "/repo/worktree",
      }).verdict,
    ).toBe("default-continue");
  });

  test.each([
    String.raw`bun $'run' tsc`,
    String.raw`bun $'$(bit issue claim)'`,
    String.raw`codex $'login status' --foo`,
    "bun ${x:-$'run'} tsc",
    String.raw`bun test > $'/tmp/result\q'`,
    String.raw`cd $'/repo/worktree\q' && bun run tsc`,
    String.raw`cd $'/repo/\xC3\xA9' && bun run tsc`,
  ])("ANSI-C words never inherit an automatic allow: %s", (command) => {
    expect(
      evaluateCommand(command, rules, {
        trustedLeadingCdTarget: "/repo/worktreeq",
      }).verdict,
    ).toBe("ask");
  });

  test("output redirection remains an ask even with a trusted cd", () => {
    expect(
      evaluateCommand("cd /repo/worktree > /tmp/out && bun test", rules, {
        trustedLeadingCdTarget: "/repo/worktree",
      }).verdict,
    ).toBe("ask");
  });

  test("trusted cd does not suppress trailing default, ask, or deny", () => {
    const options = { trustedLeadingCdTarget: "/repo/worktree" };
    expect(
      evaluateCommand("cd /repo/worktree && git rev-parse HEAD", rules, options)
        .verdict,
    ).toBe("default-continue");
    expect(
      evaluateCommand("cd /repo/worktree && rm -rf /tmp/x", rules, options)
        .verdict,
    ).toBe("ask");
    expect(
      evaluateCommand("cd /repo/worktree && bit relay sync", rules, options)
        .verdict,
    ).toBe("deny");
  });

  test("preserves a path-specific allow without basename widening", () => {
    expect(
      evaluateCommand("~/.claude/hooks/lib/codex-stage.sh review", rules)
        .verdict,
    ).toBe("allow");
    for (const command of [
      "/tmp/codex-stage.sh review",
      "~/_claude/hooks/lib/codex-stage.sh review",
      '"~/.claude/hooks/lib/codex-stage.sh" review',
      String.raw`\~/.claude/hooks/lib/codex-stage.sh review`,
    ]) {
      expect(evaluateCommand(command, rules).verdict).toBe("default-continue");
    }
  });

  const productionRules = loadRules(
    readFileSync(
      resolve(
        import.meta.dir,
        "../../pi/extensions/pi-harness/permission-rules.json",
      ),
      "utf8",
    ),
  );

  const broadPackageManagerRules = loadRules(
    JSON.stringify({
      deny: [],
      allow: [{ pattern: "^(?:bun|pnpm|npm|yarn)(?: |(?![\\s\\S]))" }],
      ask: [],
    }),
  );

  test("does not let broad package-manager grants approve package runners", () => {
    for (const command of [
      "bun x totally-unknown-package",
      String.raw`bun \x totally-unknown-package`,
      "bun 'x' totally-unknown-package",
      "bun x --package totally-unknown-package tool",
      "bun --cwd . x totally-unknown-package",
      "bun --cwd=. x run",
      "bun --version x totally-unknown-package",
      "bun --version=false x totally-unknown-package",
      "bun --help x totally-unknown-package",
      "bun --help=full x totally-unknown-package",
      "bun --revision x totally-unknown-package",
      "bun --revision=false x totally-unknown-package",
      "bun --future-option x totally-unknown-package",
      "pnpm dlx totally-unknown-package",
      "pnpm --silent dlx totally-unknown-package",
      "pnpm exec totally-unknown-package",
      "pnpm --dir . exec totally-unknown-package",
      "pnpm --filter=foo dlx run",
      "pnpm x totally-unknown-package",
      "pnpm --silent x totally-unknown-package",
      "pnpm --version=false exec totally-unknown-package",
      "pnpm --future-option exec totally-unknown-package",
      "npm exec totally-unknown-package",
      "npm exe totally-unknown-package",
      "npm --yes exe totally-unknown-package",
      "npm x totally-unknown-package",
      "npm --yes exec totally-unknown-package",
      "npm --prefix . x totally-unknown-package",
      "npm --prefix=x exec totally-unknown-package",
      "npm --version=false x totally-unknown-package",
      "npm --future-option exec totally-unknown-package",
      "yarn dlx totally-unknown-package",
      "yarn exec totally-unknown-package",
      "yarn --cwd . dlx totally-unknown-package",
      "yarn --version=false exec totally-unknown-package",
      "yarn --future-option exec totally-unknown-package",
    ]) {
      expect(evaluateCommand(command, broadPackageManagerRules).verdict).toBe(
        "ask",
      );
    }
    for (const command of [
      "bun run x",
      "bun test x",
      "bun add x",
      "bun --cwd . run x",
      "bun --cwd=. run x",
      "bun --cwd x run test",
      "bun --silent run x",
      `bun -e 'console.log("safe")' x totally-unknown-package`,
      "bun -e1 x totally-unknown-package",
      `bun --print '"safe"' x totally-unknown-package`,
      "bun -p1 x totally-unknown-package",
      "pnpm run exec",
      "pnpm test exec",
      "pnpm add exec",
      "pnpm --dir . run exec",
      "pnpm --dir=. run exec",
      "pnpm --dir exec run test",
      "pnpm --filter foo run exec",
      "pnpm --recursive run exec",
      "pnpm --version exec totally-unknown-package",
      "pnpm --help dlx totally-unknown-package",
      "npm run x",
      "npm test exec",
      "npm --prefix . run x",
      "npm --prefix x run exec",
      "npm --version x totally-unknown-package",
      "npm --help exec totally-unknown-package",
      "yarn run dlx",
      "yarn test exec",
      "yarn --cwd . run exec",
      "yarn --cwd dlx run test",
      "yarn --version dlx totally-unknown-package",
      "yarn --help exec totally-unknown-package",
    ]) {
      expect(evaluateCommand(command, broadPackageManagerRules).verdict).toBe(
        "allow",
      );
    }
  });

  test("allows the documented codex-reviewer staging, prompt, and cleanup commands", () => {
    const instruction =
      "printf '%s' 'Read /tmp/codex-reviewer-a1B2C3/prompt.md completely and follow it exactly.'";
    for (const wrapper of [
      "~/.claude/hooks/lib/codex-stage.sh prompt --timeout 600",
      "~/.claude/hooks/lib/codex-stage.sh prompt --dir '/tmp/My Repo' --timeout 600",
    ]) {
      expect(
        evaluateCommand(`${instruction} |\n  ${wrapper}`, productionRules)
          .verdict,
      ).toBe("allow");
    }

    const staging =
      'bun -e \'const { mkdtemp } = await import("node:fs/promises"); console.log(await mkdtemp("/tmp/codex-reviewer-"));\'';
    const cleanup =
      'bun -e \'const { rm } = await import("node:fs/promises"); await rm("/tmp/codex-reviewer-a1B2C3", { recursive: true, force: true });\'';
    expect(evaluateCommand(staging, productionRules).verdict).toBe("allow");
    expect(evaluateCommand(cleanup, productionRules).verdict).toBe("allow");
  });

  test("does not widen the codex-stage allow to unsafe prompt forms", () => {
    const wrapper = "~/.claude/hooks/lib/codex-stage.sh prompt --dir /tmp";
    expect(
      evaluateCommand(
        `printf '%s' "$(bit relay sync)" | ${wrapper}`,
        productionRules,
      ).verdict,
    ).toBe("deny");
    expect(
      evaluateCommand(
        `printf '%s' "$(cat ~/.ssh/id_ed25519)" | ${wrapper}`,
        productionRules,
      ).verdict,
    ).toBe("ask");
    for (const command of [
      "printf '%s' 'review this' | /tmp/codex-stage.sh prompt",
      `printf '%s' 'review this' | ~/.claude/hooks/lib/codex-stage.sh prompt --dir "$PWD"`,
      "~/.claude/hooks/lib/codex-stage.sh prompt <<< 'review this'",
      "~/.claude/hooks/lib/codex-stage.sh prompt < /tmp/review-prompt.md",
    ]) {
      expect(evaluateCommand(command, productionRules).verdict).toBe(
        "default-continue",
      );
    }
    expect(
      evaluateCommand(
        [
          "~/.claude/hooks/lib/codex-stage.sh prompt << 'PROMPT_EOF'",
          "review this",
          "PROMPT_EOF",
        ].join("\n"),
        productionRules,
      ).verdict,
    ).toBe("deny");
  });

  test.each([
    "bun\u00a0evil",
    "bun\u000cevil",
    "bun\u2028evil",
    "bun\u2028",
    "bun\u2029",
    "bun\r",
    "bit\u00a0issue\u00a0init",
    "codex\u00a0login\u00a0status",
  ])(
    "does not treat non-shell Unicode whitespace as a separator: %s",
    (command) => {
      expect(evaluateCommand(command, productionRules).verdict).toBe(
        "default-continue",
      );
    },
  );

  test.each([
    "codex 'login status' --foo",
    "bit issue 'create --foo'",
    String.raw`codex login\ status --foo`,
  ])("preserves an embedded-whitespace argv boundary: %s", (command) => {
    expect(evaluateCommand(command, productionRules).verdict).toBe(
      "default-continue",
    );
  });
});

describe("permission judge config", () => {
  test("is enabled with local-only defaults when the config file is absent", () => {
    const paths = resolvePaths(join(tmpdir(), `missing-pi-home-${Date.now()}`));
    expect(loadConfig({}, paths).permissionJudge).toEqual(
      DEFAULT_PERMISSION_JUDGE_CONFIG,
    );
  });

  test("loads overrides, ignores the retired confirm timeout, and matches child profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-judge-config-"));
    const paths = resolvePaths(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      paths.localConfigFile,
      JSON.stringify({
        permissionJudge: {
          enabled: false,
          url: "http://[::1]:11500/api/chat",
          model: "local/model:1.5b",
          expectedDigest:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          timeoutMs: 750,
          confirmTimeoutMs: 5_000,
          keepAlive: "2h",
        },
      }),
    );

    try {
      const parent = loadConfig({}, paths).permissionJudge;
      const child = loadConfig(
        { PI_HARNESS_CHILD: "1" },
        paths,
      ).permissionJudge;
      expect(parent).toEqual({
        enabled: false,
        url: "http://[::1]:11500/api/chat",
        model: "local/model:1.5b",
        expectedDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        timeoutMs: 750,
        keepAlive: "2h",
      });
      expect(child).toEqual({
        enabled: false,
        url: "http://[::1]:11500/api/chat",
        model: "local/model:1.5b",
        expectedDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        timeoutMs: 750,
        keepAlive: "2h",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("marks explicit unsafe or out-of-range values unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-judge-invalid-config-"));
    const paths = resolvePaths(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      paths.localConfigFile,
      JSON.stringify({
        permissionJudge: {
          url: "https://example.com/api/chat",
          model: "qwen2.5",
          expectedDigest: "sha256:not-a-digest",
          timeoutMs: 10,
          keepAlive: "0m",
        },
      }),
    );

    try {
      expect(loadConfig({}, paths).permissionJudge?.configurationError).toBe(
        "invalid permissionJudge fields: url, model, expectedDigest, timeoutMs, keepAlive",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects explicit null fields instead of silently defaulting them", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-judge-null-config-"));
    const paths = resolvePaths(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      paths.localConfigFile,
      JSON.stringify({
        permissionJudge: {
          enabled: null,
          url: null,
          model: null,
          expectedDigest: null,
          timeoutMs: null,
          keepAlive: null,
        },
      }),
    );

    try {
      expect(loadConfig({}, paths).permissionJudge?.configurationError).toBe(
        "invalid permissionJudge fields: enabled, url, model, expectedDigest, timeoutMs, keepAlive",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("loadRules fail-closed behavior", () => {
  test.each([undefined, "not-json"])(
    "retains the built-in deny floor for %s",
    (jsonText) => {
      expect(
        evaluateCommand("bit issue claim x", loadRules(jsonText)).verdict,
      ).toBe("deny");
    },
  );

  test("compensates for an invalid deny regex", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [{ pattern: "([", reason: "壊れたルール" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("bit issue claim x", rules).verdict).toBe("deny");
  });

  test("evaluates deny before allow", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [{ pattern: "^echo secret$", reason: "拒否" }],
        allow: [{ pattern: "^echo secret$" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("echo secret", rules).verdict).toBe("deny");
  });

  test("evaluates the mandatory structural risk floor before allow", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^git reset --hard" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("git reset --hard HEAD~1", rules).verdict).toBe(
      "ask",
    );
  });
});

describe("evaluateCommand compound-command scanning", () => {
  const floor = loadRules(undefined);
  const verdictOf = (command: string) =>
    evaluateCommand(command, floor).verdict;

  // The finding: a benign prefix used to hide a denied/destructive command.
  test.each([
    ["echo ok; bit issue claim 123", "bit issue claim は禁止です"],
    ["cd / && bit relay serve", "bit relay は禁止です"],
    ["true || bit issue unclaim 5", "bit issue unclaim は禁止です"],
    ["echo x | bit issue claim", "bit issue claim は禁止です"],
    ["bit issue claim &", "bit issue claim は禁止です"],
    ["cd /tmp\nbit pr import 7", "bit pr import は禁止です"],
    ["(bit issue claim)", "bit issue claim は禁止です"],
    ["{ bit issue claim; }", "bit issue claim は禁止です"],
  ])("denies denied command after a benign prefix: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  test.each([
    "echo ok && rm -rf /tmp/x",
    "cd /tmp && git reset --hard HEAD~1",
    "true; git push origin main --force",
    "make build && git clean -fd",
  ])("asks for a destructive command after a benign prefix: %s", (command) => {
    expect(verdictOf(command)).toBe("ask");
  });

  // Quoting / escaping must NOT create a phantom denied segment.
  test.each([
    'echo "a; bit issue claim"',
    "echo 'a; bit issue claim'",
    "echo ok\\; bit_issue_claim",
    'git commit -m "wip; bit issue claim later"',
    "echo ok # ; bit issue claim",
    "echo ok # bit relay serve",
  ])("does not deny a quoted/escaped/commented operator: %s", (command) => {
    expect(verdictOf(command)).toBe("default-continue");
  });

  // Separator obfuscation via $IFS still resolves to the denied command.
  test.each([
    "bit${IFS}issue${IFS}claim",
    "bit$IFS issue claim",
    "echo ok; bit${IFS}relay${IFS}serve",
  ])("normalizes $IFS separators: %s", (command) => {
    expect(verdictOf(command)).toBe("deny");
  });

  // Command substitution content is evaluated recursively.
  test.each([
    "echo $(bit issue claim)",
    "echo `bit issue claim`",
    "echo $(echo $(bit issue claim))",
    "diff <(bit issue claim) other",
    'echo "$(bit issue claim)"',
  ])("recurses into command substitutions: %s", (command) => {
    expect(verdictOf(command)).toBe("deny");
  });

  // Structurally unparseable input fails closed.
  test.each([
    'echo "unterminated',
    "echo 'unterminated",
    "echo $(bit issue claim",
    "echo `bit issue claim",
    "echo ${unterminated",
  ])("denies unparseable input: %s", (command) => {
    expect(verdictOf(command)).toBe("deny");
  });

  // Opaque executors that cannot be statically inspected → ask.
  test.each([
    'eval "bit issue claim"', // eval body is re-parsed dynamically; not recursed
    'bash -c "rm -rf /"', // interpreter -c body recurses to a destructive ask
    'sh -c "$CMD"', // interpreter -c body is opaque → nothing to inspect
    'sh -c "echo hi"', // interpreter -c body is benign → stays opaque-executor ask
    "echo x | xargs rm",
  ])("asks for opaque executors: %s", (command) => {
    expect(verdictOf(command)).toBe("ask");
  });

  // Transparent wrappers and assignments are stripped before matching.
  test.each([
    "sudo bit issue claim",
    "env bit issue claim",
    "FOO=bar bit issue claim",
    "FOO=bar sudo bit issue claim",
    "nice bit relay serve",
  ])("strips wrappers/assignments before the rule floor: %s", (command) => {
    expect(verdictOf(command)).toBe("deny");
  });

  test("asks for a destructive command behind sudo", () => {
    expect(verdictOf("sudo rm -rf /")).toBe("ask");
  });

  // Benign compound commands stay untouched.
  test.each([
    "cd /tmp && ls -la",
    "git status && git rev-parse HEAD",
    "echo one; echo two; echo three",
    "cat file | grep foo | wc -l",
    "bit issue list --open && echo done",
  ])("continues benign compound commands: %s", (command) => {
    expect(verdictOf(command)).toBe("default-continue");
  });

  test("combines to deny across mixed segments (deny wins over ask)", () => {
    expect(verdictOf("rm -rf /tmp/x && bit issue claim")).toBe("deny");
  });

  test("allow only wins when every shell segment is explicitly allowed", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^echo safe" }],
        ask: [],
      }),
    );
    // Every executable segment is covered by the explicit trust grant.
    expect(
      evaluateCommand("echo safe one && echo safe two", rules).verdict,
    ).toBe("allow");
    // A mixed allowed/default command remains the default.
    expect(evaluateCommand("echo safe one && echo done", rules).verdict).toBe(
      "default-continue",
    );
  });
});

describe("permission-policy compound bypass integration", () => {
  test("blocks a denied command hidden behind a benign prefix", async () => {
    const pi = createPermissionPi();

    expect(
      await pi.emitToolCall(bashCall("echo ok; bit issue claim 123")),
    ).toEqual({ block: true, reason: "bit issue claim は禁止です" });
  });

  test("blocks unparseable bash input (fail-closed)", async () => {
    const pi = createPermissionPi();

    expect(await pi.emitToolCall(bashCall('echo "unterminated'))).toEqual({
      block: true,
      reason: expect.stringContaining("解析できませんでした"),
    });
  });

  test("confirms a destructive command hidden behind a benign prefix", async () => {
    const pi = createPermissionPi();
    pi.queueConfirm(false);

    expect(
      await pi.emitToolCall(bashCall("cd /tmp && git reset --hard HEAD~1")),
    ).toEqual({ block: true, reason: expect.any(String) });
  });
});

describe("evaluateCommand fail-closed for dynamic/unsupported syntax (#6:1)", () => {
  const floor = loadRules(undefined);
  const verdictOf = (command: string) =>
    evaluateCommand(command, floor).verdict;
  // Distinctive fragment of POTENTIALLY_SENSITIVE_REASON.
  const SPECULATIVE = "動的展開";

  // A denied/dangerous command whose discriminator is produced by an
  // unresolved expansion, brace/glob, redirection prefix, reserved word, or
  // opaque head must not slip through. deny-family → ask (not certain);
  // concrete-after-normalization → deny.
  test.each([
    // dynamic expansion at a discriminating position (bit deny family → ask)
    'bit issue "$op"',
    "bit issue $(printf claim)",
    "bit issue `printf claim`",
    'bit issue "${SUB}"',
    "bit issue ${x:-claim}",
    'bit pr "$sub"',
    'bit "$x"',
    'bit clone "$target"',
    // brace / glob expansion
    "bit issue c{l,}aim",
    "bit issue cl?im",
    // opaque / ambiguous head
    "$cmd issue claim",
    "sudo -n bit issue claim",
    // destructive with literal danger flags + opaque operand
    'rm -rf "$dir"',
    'chmod -R "$mode" /etc',
  ])("escalates to ask: %s", (command) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "ask",
      reason: expect.stringContaining(SPECULATIVE),
    });
  });

  // Concrete after normalization (redirection stripped, reserved word stripped,
  // nested substitution recursed) → hard deny.
  test.each([
    "2>/tmp/x bit issue claim",
    "{fd}>/tmp/x bit issue claim",
    ">out bit relay serve",
    "bit issue claim >/tmp/x",
    "bit issue claim &>/tmp/x",
    "bit relay serve >|out",
    "exec bit issue claim",
    "! bit issue claim",
    "then bit issue claim",
    "if bit issue claim; then :; fi",
    "echo ok\nbit issue claim",
    'echo "${x:-$(bit issue claim)}"',
    "echo $(( $(bit issue claim) + 0 ))",
    "bit issue $(bit issue claim)",
    // backslash / ANSI-C obfuscation decodes to the literal keyword
    "b\\it issue claim",
    "bit issue cl\\aim",
    "bit issue $'claim'",
  ])("denies after normalization/recursion: %s", (command) => {
    expect(verdictOf(command)).toBe("deny");
  });

  test.each([
    [`bun "$'$(bit issue claim)'"`, "bit issue claim は禁止です"],
    [`bun "\${v:-$'$(bit issue claim)'}"`, "コマンドを解析できませんでした"],
    [`bun "\${v:-'$(bit issue claim)'}"`, "コマンドを解析できませんでした"],
    [`bun "\${v:-"$'$(bit issue claim)'"}"`, "bit issue claim は禁止です"],
    [`bun "\${v:-"'$(bit issue claim)'"}"`, "bit issue claim は禁止です"],
    [
      `bun "\${v:-$(printf %s 'x}'; bit issue claim)}"`,
      "bit issue claim は禁止です",
    ],
    [`bun "\${v:-$'\`bit issue claim\`'}"`, "コマンドを解析できませんでした"],
    [
      `v=x; echo "\${v#'{'}"; bit issue claim; echo "}"`,
      "コマンドを解析できませんでした",
    ],
  ])(
    "denies a substitution or brace hidden by ambiguous apostrophes: %s",
    (command, reason) => {
      expect(evaluateCommand(command, floor)).toEqual({
        verdict: "deny",
        reason: expect.stringContaining(reason),
      });
    },
  );

  test.each(['bun "$\\\n(bit issue claim)"', "bit issue cl\\\naim"])(
    "fails closed when a line continuation can synthesize syntax: %s",
    (command) => {
      expect(evaluateCommand(command, floor)).toEqual({
        verdict: "deny",
        reason: expect.stringContaining("コマンドを解析できませんでした"),
      });
    },
  );

  test("fails closed when nested substitution exceeds the reader cap", () => {
    let nested = "bit issue claim";
    for (let depth = 0; depth < 66; depth += 1) nested = `$(${nested})`;
    const command = `bun "\${v:-"${nested}"}"`;

    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason: expect.stringContaining("コマンドを解析できませんでした"),
    });
  });

  // Bash here-doc parsing needs header-wide FIFO state, quote removal, and
  // logical-line handling. Until that grammar is implemented completely,
  // every top-level `<<` form fails closed instead of risking that its body or
  // a later command gets swallowed by the scanner. `$((... << ...))` remains
  // supported because readDollar consumes the balanced arithmetic expansion.
  test.each([
    "cat <<EOF\nbit issue claim\nEOF",
    "cat <<'EOF'\nbit issue claim\nEOF",
    "cat <<EOF\n'$(bit issue claim)'\nEOF",
    "cat <<EOF\n$(\nbit issue claim\n)\nEOF",
    "cat <<EOF; echo $(bit issue claim)\nplain\nEOF",
    "cat <<A <<B\nplain\nA\n'$(bit issue claim)'\nB",
    "cat <<EOF\n EOF\n'$(bit issue claim)'\nEOF",
    "cat <<$'\\q'\nbody\n\\q\nbit issue claim",
    "cat <<-EOF\n\tplain\n\tEOF\nbit issue claim",
    "cat <\\\n<EOF\n'$(bit issue claim)'\nEOF",
    "! ((1 << 2))\nbit issue claim",
  ])("fails closed on unsupported or ambiguous `<<` syntax: %s", (command) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason: expect.stringContaining("コマンドを解析できませんでした"),
    });
  });

  test.each(["bun '$(bit issue claim)'", "bun '$\\\n(bit issue claim)'"])(
    "keeps substitutions inside genuine literal quotes inert: %s",
    (command) => {
      expect(verdictOf(command)).toBe("default-continue");
    },
  );

  test.each(["echo $((1 << 2))", 'cat <<<"hello"'])(
    "keeps a supported less-than form: %s",
    (command) => {
      expect(verdictOf(command)).toBe("default-continue");
    },
  );

  test("keeps opaque git-clean flags on the residual path", () => {
    expect(verdictOf('git clean "$a" "$b"')).toBe("default-continue");
  });

  test("plain or dynamically-targeted push is always a deterministic ask", () => {
    expect(verdictOf('git push a b c d e f g "$force"')).toBe("ask");
    expect(verdictOf('git push origin "$branch"')).toBe("ask");
  });

  // False-positive guards — these MUST stay default-continue or subagents break.
  test.each([
    'git commit -m "$msg"',
    'git commit -m "$a" "$b"',
    'git log --oneline "$ref"',
    'git checkout "$branch"',
    'bit issue view "$id"',
    'bit issue list "$filter"',
    'bit list "$x"',
    "bit clone https://example.test/x",
    'echo "$x"',
    'cat "$f"',
    'cd "$dir" && make',
    'grep "$pat" file',
    'rm -f "$f"',
    'rm "$path"',
    "rm *.log",
    'chmod "$mode" file',
    'chmod 644 "$f"',
    "cat file 2>&1",
    "echo hi 1>&2",
    "make 2>&1 | grep x",
    "ls {a,b}.ts",
    "echo *.ts",
  ])("stays default-continue (no over-ask): %s", (command) => {
    expect(verdictOf(command)).toBe("default-continue");
  });

  test("output redirection is a deterministic ask", () => {
    expect(verdictOf('echo hi > "$out"')).toBe("ask");
  });

  test("cross-segment: a speculative ask elevates the whole command", () => {
    expect(verdictOf('echo "$x" && bit issue "$op"')).toBe("ask");
  });

  test("IFS separators combine with a trailing opaque subcommand", () => {
    expect(verdictOf('bit${IFS}issue${IFS}"$op"')).toBe("ask");
  });

  test("empty quoted redirect target does not swallow the command", () => {
    expect(verdictOf("<<<'' bit issue claim")).toBe("deny");
  });

  // The mandatory data-leak floor cannot be suppressed by a user allow rule.
  test("built-in deny-potential beats a user allow rule", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^bit\\s+issue" }],
        ask: [],
      }),
    );
    expect(evaluateCommand('bit issue "$op"', rules)).toEqual({
      verdict: "ask",
      reason: expect.stringContaining(SPECULATIVE),
    });
  });

  test("a user allow rule cannot suppress the mandatory structural risk floor", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^git reset --hard" }],
        ask: [],
      }),
    );
    expect(evaluateCommand("git reset --hard HEAD~1", rules).verdict).toBe(
      "ask",
    );
  });
});

describe("evaluateCommand normalization bypasses (#7:1)", () => {
  const floor = loadRules(undefined);
  const verdictOf = (command: string) =>
    evaluateCommand(command, floor).verdict;

  // Absolute/relative-path spellings of a floor command are basename-normalized
  // so an abs-path executor cannot dodge the deny floor.
  test.each([
    ["/usr/bin/bit relay serve", "bit relay は禁止です"],
    ["/bin/bit issue claim 1", "bit issue claim は禁止です"],
    ["~/bin/bit relay sync", "bit relay は禁止です"],
    ["sudo /usr/bin/bit relay serve", "bit relay は禁止です"],
    ["/usr/bin/sudo bit relay serve", "bit relay は禁止です"],
  ])("denies path-spelled floor command: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  // A shell interpreter's concrete `-c` body is evaluated: a denied body is
  // denied, not downgraded to an opaque-executor ask.
  test.each([
    ["sh -c 'bit relay sync'", "bit relay は禁止です"],
    ["/bin/sh -c 'bit relay sync'", "bit relay は禁止です"],
    ['bash -c "bit issue claim 1"', "bit issue claim は禁止です"],
    ["env /bin/zsh -c 'bit issue unclaim 9'", "bit issue unclaim は禁止です"],
  ])("denies interpreter -c with a denied body: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  // bit global option / repo / hub spellings fold to the real subcommand.
  test.each([
    ["bit -C /repo relay sync", "bit relay は禁止です"],
    ["bit -C . issue claim 1", "bit issue claim は禁止です"],
    ["bit repo relay serve", "bit relay は禁止です"],
    ["bit repo issue claim 2", "bit issue claim は禁止です"],
    ["bit hub issue claim 1", "bit issue claim は禁止です"],
    ["bit hub pr import 5", "bit pr import は禁止です"],
    ["bit hub sync", "bit relay は禁止です"],
    ["bit hub serve", "bit relay は禁止です"],
    ["bit -C /repo repo relay sync", "bit relay は禁止です"],
  ])("denies bit alias/option spelling: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  // clone relay+ is denied even when options precede the operand.
  test.each([
    "bit clone relay+ssh://x",
    "bit clone --depth 1 relay+ssh://x",
    "bit clone -- relay+ssh://x",
    "bit repo clone relay+ssh://x",
    "bit -C /repo clone --bare relay+ssh://x",
  ])("denies clone relay+ regardless of option position: %s", (command) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason: "bit clone relay+ は禁止です",
    });
  });

  // Abs-path bit with a dynamic subcommand still escalates to ask.
  test.each(['/usr/bin/bit issue "$op"', 'bit -C /repo issue "$op"'])(
    "escalates path/aliased bit with dynamic subcommand to ask: %s",
    (command) => {
      expect(verdictOf(command)).toBe("ask");
    },
  );

  // Normalization must NOT over-block benign path/alias spellings: a known head
  // with a benign grammar stays default-continue, matching its bare form.
  test.each([
    "/usr/bin/git status",
    "/usr/bin/bit issue list --open",
    "bit -C /repo issue list --open",
    "bit repo status",
    "bit clone https://example.test/x",
    "bit clone --depth 1 https://example.test/x",
    "/bin/ls -la",
  ])("keeps benign path/alias spelling default-continue: %s", (command) => {
    expect(verdictOf(command)).toBe("default-continue");
  });

  // Interpreter -c recursion must reach through nested interpreter layers so a
  // doubly-wrapped denied body cannot dodge the floor.
  test.each([
    ["sh -c 'sh -c \"bit relay sync\"'", "bit relay は禁止です"],
    ["bash -c \"sh -c 'bit issue claim 1'\"", "bit issue claim は禁止です"],
  ])("denies a nested interpreter -c body: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  // Multiple/stacked bit global options are all stripped before the subcommand.
  test.each([
    ["bit -C /a -C /b relay sync", "bit relay は禁止です"],
    ["bit -h relay sync", "bit relay は禁止です"],
  ])("strips stacked bit global options: %s", (command, reason) => {
    expect(evaluateCommand(command, floor)).toEqual({
      verdict: "deny",
      reason,
    });
  });

  // Interpreter forms with no inspectable -c body: opaque-executor ask when a
  test("an interpreter -c with no argument stays ask", () => {
    expect(verdictOf("sh -c")).toBe("ask");
  });
  test("an interpreter script remains opaque execution", () => {
    expect(verdictOf("sh script.sh")).toBe("ask");
  });
});

describe("permission-policy #6:1 integration", () => {
  test("blocks a dynamic-subcommand denied command in a non-interactive session", async () => {
    const pi = createPermissionPi(false);
    expect(await pi.emitToolCall(bashCall('bit issue "$op"'))).toEqual({
      block: true,
      reason: expect.stringContaining("動的展開"),
    });
  });

  test("confirms the same command interactively", async () => {
    const accepted = createPermissionPi(true);
    accepted.queueConfirm(true);
    expect(
      await accepted.emitToolCall(bashCall('bit issue "$op"')),
    ).toBeUndefined();

    const rejected = createPermissionPi(true);
    rejected.queueConfirm(false);
    expect(await rejected.emitToolCall(bashCall('bit issue "$op"'))).toEqual({
      block: true,
      reason: expect.any(String),
    });
  });

  test("blocks a redirection-prefixed denied command", async () => {
    const pi = createPermissionPi();
    expect(await pi.emitToolCall(bashCall("2>/tmp/x bit issue claim"))).toEqual(
      { block: true, reason: "bit issue claim は禁止です" },
    );
  });
});
