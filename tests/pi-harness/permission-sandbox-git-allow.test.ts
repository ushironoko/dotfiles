import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import type { PermissionAuditIntegration } from "../../pi/extensions/pi-harness/features/permission-audit";
import type { PermissionAuditStage } from "../../pi/extensions/pi-harness/features/permission-audit/model";
import type { PermissionProjectContext } from "../../pi/extensions/pi-harness/features/permission-policy/context";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { ToolCallEvent } from "../../pi/extensions/pi-harness/lib/pi-like";
import { createFakePi } from "./fake-pi";

const JUDGE_SENTINEL = "test judge must not be reached";

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
  paths: resolvePaths("/tmp/pi-sandbox-git-allow-test"),
  permissionJudge: {
    ...DEFAULT_PERMISSION_JUDGE_CONFIG,
    configurationError: JUDGE_SENTINEL,
  },
};

const REPOSITORY_CWD = resolve(import.meta.dir, "../..");

const executionBoundary = (toolName: string) => ({
  mode:
    toolName === "bash_escalated"
      ? ("escalated" as const)
      : ("sandboxed" as const),
  network: "allowlisted" as const,
  profileFingerprint: "b".repeat(64),
  ...(toolName === "bash_escalated"
    ? {}
    : {
        writableWorktrees: [REPOSITORY_CWD],
        worktreeCreateRoots: [resolve(REPOSITORY_CWD, "..")],
      }),
});

const verifiedProject = (cwd: string): PermissionProjectContext => ({
  kind: "git",
  name: "dotfiles",
  cwd,
  activeWorktree: cwd,
  navigableRoots: [cwd],
  worktrees: [cwd],
  fingerprint: `project:${cwd}`,
});

const captureAuditStages = () => {
  const stages: { toolCallId: string; stage: PermissionAuditStage }[] = [];
  const integration: PermissionAuditIntegration = {
    lineageId: "sandbox-git-allow-test",
    addStage(toolCallId, stage) {
      stages.push({ toolCallId, stage });
    },
    updateContext() {},
    async finalizeBlock() {
      return true;
    },
    registerTail() {},
    childEnvironment() {
      return {};
    },
  };
  return { integration, stages };
};

const bashCall = (command: string, id: string): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: id,
  input: { command },
});

const escalatedCall = (command: string, id: string): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash_escalated",
  toolCallId: id,
  input: { command },
});

describe("sandbox Git deterministic allow routing", () => {
  test("bypasses the local judge for every selected command", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    let discoveries = 0;
    setupPermissionPolicy(pi, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => {
        discoveries += 1;
        return verifiedProject(cwd);
      },
    });

    const commands = [
      "git status --short --branch",
      "git show --stat HEAD",
      "git log -1 --oneline",
      "git diff --check",
      "git rev-parse --show-toplevel",
      "git merge-base main HEAD",
      "git ls-files --cached",
      "git ls-tree --name-only HEAD",
      "git show-ref --head",
      "git for-each-ref --format='%(refname)' refs/heads",
      "git describe --always HEAD",
      "git name-rev --name-only HEAD",
      "git rev-list --count main",
      "git branch --show-current",
      "git worktree list --porcelain",
      "git remote",
      "git stash list --oneline",
      "git tag --list v1.0.0",
      "git merge --no-edit feature/topic",
      "git switch feature/topic",
      "git merge-tree --write-tree main feature/topic",
      "git fetch origin main",
      "git commit -m 'sandboxed commit'",
      "git add src/parser.ts",
    ];
    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `sandbox-git-${index}`)),
      ).toBeUndefined();
    }

    expect(discoveries).toBe(6);
    expect(
      audit.stages.filter(({ stage }) => stage.type === "judge"),
    ).toHaveLength(0);
    expect(
      audit.stages.filter(
        ({ stage }) =>
          stage.type === "deterministic" &&
          stage.reasonCode === "sandbox-git-allow",
      ),
    ).toHaveLength(commands.length);
  });

  test("retains deterministic confirmation for dangerous variants", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    setupPermissionPolicy(pi, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => verifiedProject(cwd),
    });

    const commands = [
      "git fetch --force origin main",
      "git fetch -fp origin main:main",
      "git fetch --stdin origin",
      "git fetch --upload-pack=/tmp/helper . HEAD",
      "git fetch custom://payload",
      "git fetch origin main:refs/notes/review",
      "git switch --force main",
      "git switch -C main HEAD~5",
      "git switch --merge main",
      "git commit --amend -m message",
      "git commit --pathspec-from-file=paths.txt -m message",
      "git merge --abort",
      "git add -f .env",
      "git add --pathspec-from-file=paths.txt",
      "git add ../../outside.txt",
      "git show HEAD:.ssh/id_ed25519",
      "git show --all -- ':(top).ssh/id_ed25519'",
      "git --git-dir=/tmp/unrelated/.git status --short",
    ];
    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `dangerous-git-${index}`)),
      ).toEqual({ block: true, reason: expect.any(String) });
    }

    expect(
      audit.stages.filter(({ stage }) => stage.type === "judge"),
    ).toHaveLength(0);
  });

  test("bypasses the judge for verified path-free project readers", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    let discoveries = 0;
    setupPermissionPolicy(pi, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => {
        discoveries += 1;
        return verifiedProject(cwd);
      },
    });

    const commands = ["pwd -P", "jq -n '1 + 1'"];
    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `sandbox-reader-${index}`)),
      ).toBeUndefined();
    }

    expect(discoveries).toBe(commands.length);
    expect(
      audit.stages.filter(({ stage }) => stage.type === "judge"),
    ).toHaveLength(0);
    expect(
      audit.stages.filter(
        ({ stage }) =>
          stage.type === "deterministic" &&
          stage.reasonCode === "sandbox-read-allow",
      ),
    ).toHaveLength(commands.length);
  });

  test("requires verified writable capabilities for git -C and worktree lifecycle", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    let discoveries = 0;
    setupPermissionPolicy(pi, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => {
        discoveries += 1;
        return {
          ...verifiedProject(cwd),
          leadingNavigation: {
            scope: "listed-worktree" as const,
            sameRepository: true,
          },
        };
      },
    });

    const target = resolve(cwd, "../sandbox-worktree-new");
    const commands = [
      `git -C ${cwd} rev-parse HEAD`,
      `git -C ${cwd} commit -m message`,
      `git worktree add -b feature/sandbox ${target}`,
      `git worktree lock ${cwd}`,
      `git worktree unlock ${cwd}`,
    ];
    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `sandbox-worktree-${index}`)),
      ).toBeUndefined();
    }

    expect(discoveries).toBe(commands.length);
    expect(
      audit.stages.filter(({ stage }) => stage.type === "judge"),
    ).toHaveLength(0);
    expect(
      audit.stages.filter(
        ({ stage }) =>
          stage.type === "deterministic" &&
          stage.reasonCode === "sandbox-git-allow",
      ),
    ).toHaveLength(commands.length);
  });

  test("keeps unproven reader and Git modes on the judge route", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    setupPermissionPolicy(pi, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => verifiedProject(cwd),
    });

    const commands = [
      "git branch -- --list",
      "git tag -- --list",
      "git remote -v",
      "git pull --ff-only",
      "git pull --ff-only --no-rebase --no-autostash https://github.com/example/repo.git main",
      "ls -la .",
      "stat package.json",
      "cat package.json",
      "grep -n scripts package.json",
      "jq '.scripts' package.json",
      "cat .env",
      "grep -R token .",
      "jq -n env",
      `jq -n '"\\(env)"'`,
    ];
    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `sandbox-residual-${index}`)),
      ).toEqual({
        block: true,
        reason: expect.stringContaining(JUDGE_SENTINEL),
      });
    }
    expect(
      audit.stages.filter(
        ({ stage }) =>
          stage.type === "judge" && stage.outcome === "unavailable",
      ),
    ).toHaveLength(commands.length);
  });

  test("does not bypass verified-project or sandbox boundaries", async () => {
    const cwd = resolve(import.meta.dir, "../..");
    const unavailable = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(unavailable, config, {
      executionBoundary,
      discoverProject: async () => ({
        kind: "unavailable",
        cwd,
        reason: "test discovery failure",
        fingerprint: "project:unavailable",
      }),
    });

    expect(
      await unavailable.emitToolCall(
        bashCall("git commit -m message", "unavailable-project"),
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining(
        "プロジェクト境界を検証できないため変更コマンドには確認が必要です",
      ),
    });

    const unverifiedGitC = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(unverifiedGitC, config, {
      executionBoundary,
      discoverProject: async () => ({
        ...verifiedProject(cwd),
        leadingNavigation: {
          scope: "outside-listed-worktrees" as const,
          sameRepository: false,
        },
      }),
    });
    expect(
      await unverifiedGitC.emitToolCall(
        bashCall("git -C /tmp/unrelated rev-parse HEAD", "unverified-git-c"),
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining(
        "git -C の対象を登録済みの同一リポジトリworktree内と確認できませんでした",
      ),
    });

    const escalated = createFakePi({ cwd, hasUI: false });
    const audit = captureAuditStages();
    setupPermissionPolicy(escalated, config, {
      executionBoundary,
      permissionAudit: audit.integration,
      discoverProject: async () => verifiedProject(cwd),
    });
    expect(
      await escalated.emitToolCall(
        escalatedCall("git status --short", "outside-sandbox"),
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining(JUDGE_SENTINEL),
    });
    expect(
      audit.stages.some(
        ({ stage }) =>
          stage.type === "judge" && stage.outcome === "unavailable",
      ),
    ).toBe(true);
  });
});
