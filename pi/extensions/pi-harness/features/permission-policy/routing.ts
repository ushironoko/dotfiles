import type { BashExecutionBoundary } from "../bash-sandbox";
import type {
  PermissionLeadingNavigation,
  PermissionProjectContext,
} from "./context";
import {
  evaluateCommandWithAudit,
  gitReadCwdTarget,
  hasProjectSensitiveMutation,
  hasUnverifiedProjectMutationNavigation,
  isSandboxResidualVerdict,
  type AuditedVerdict,
  type LoadedRules,
} from "./rules";
import { leadingTrustedCdTarget } from "./trusted-cd";

type EvaluationOptions = NonNullable<
  Parameters<typeof evaluateCommandWithAudit>[2]
>;

export interface PermissionRoutingInput {
  readonly command: string;
  readonly rules: LoadedRules;
  readonly boundary?: BashExecutionBoundary;
  readonly judgeAvailable: boolean;
  readonly initialResult?: AuditedVerdict;
  readonly projectResolved: boolean;
  readonly project?: PermissionProjectContext;
  readonly leadingNavigation?: PermissionLeadingNavigation;
  readonly gitCwdResolved: boolean;
  readonly gitCwd?: PermissionLeadingNavigation;
  readonly onEvaluation?: (
    phase: "verified-git-c" | "verified-project",
    result: AuditedVerdict,
  ) => void;
}

export type PermissionRoutingDecision =
  | {
      readonly route: "context";
      readonly requirement: "git-c" | "project";
      readonly target?: string;
    }
  | {
      readonly route: "mechanical";
      readonly verdict: "allow" | "ask" | "deny";
      readonly reason: string;
      readonly reasonCode: string;
      readonly phase:
        | "deterministic-policy"
        | "git-c"
        | "mutation-navigation"
        | "leading-navigation"
        | "project-mutation"
        | "codex-judge";
      readonly result: AuditedVerdict;
    }
  | {
      readonly route: "model";
      readonly result: AuditedVerdict;
      readonly project?: PermissionProjectContext;
      readonly leadingNavigation?: PermissionLeadingNavigation;
      readonly gitCwd?: PermissionLeadingNavigation;
    };

const mechanical = (
  verdict: "allow" | "ask" | "deny",
  result: AuditedVerdict,
  reason: string,
  reasonCode: string,
  phase: Extract<PermissionRoutingDecision, { route: "mechanical" }>["phase"],
): PermissionRoutingDecision => ({
  route: "mechanical",
  verdict,
  result,
  reason,
  reasonCode,
  phase,
});

const verifiedNavigation = (
  navigation: PermissionLeadingNavigation | undefined,
): boolean =>
  navigation?.scope === "listed-worktree" && navigation.sameRepository;

export const routePermissionCommand = (
  input: PermissionRoutingInput,
): PermissionRoutingDecision => {
  const { boundary, command, rules } = input;
  const effectSandboxed = boundary?.mode === "sandboxed";
  const isEscalated = boundary?.mode === "escalated";
  const evaluationRules = isEscalated ? { ...rules, allow: [] } : rules;
  const evaluationOptions: EvaluationOptions = {
    effectSandboxed,
    ...(effectSandboxed && boundary?.writableWorktrees !== undefined
      ? { trustedWritableWorktrees: boundary.writableWorktrees }
      : {}),
    ...(effectSandboxed && boundary?.worktreeCreateRoots !== undefined
      ? { trustedWorktreeCreateRoots: boundary.worktreeCreateRoots }
      : {}),
  };
  const evaluate = (
    phase: "verified-git-c" | "verified-project",
    options: EvaluationOptions,
  ): AuditedVerdict => {
    const result = evaluateCommandWithAudit(command, evaluationRules, options);
    input.onEvaluation?.(phase, result);
    return result;
  };

  let result =
    input.initialResult ??
    evaluateCommandWithAudit(command, evaluationRules, evaluationOptions);
  if (result.verdict === "deny") {
    return mechanical(
      "deny",
      result,
      result.reason,
      result.audit.reasonCode,
      "deterministic-policy",
    );
  }

  let trustedGitCwdTarget: string | undefined;
  if (result.verdict === "ask") {
    const target = gitReadCwdTarget(command);
    if (target !== undefined) {
      if (!input.gitCwdResolved) {
        return { route: "context", requirement: "git-c", target };
      }
      if (!verifiedNavigation(input.gitCwd)) {
        if (!isEscalated) {
          return mechanical(
            "ask",
            result,
            "git -C の対象を登録済みの同一リポジトリworktree内と確認できませんでした",
            "git-c-unverified",
            "git-c",
          );
        }
      } else {
        trustedGitCwdTarget = target;
        result = evaluate("verified-git-c", {
          ...evaluationOptions,
          trustedGitCwdTarget: target,
          ...(input.project?.kind !== "git"
            ? {}
            : {
                trustedReadContext: {
                  cwd: input.project.cwd,
                  navigableRoots: input.project.navigableRoots,
                },
              }),
        });
      }
    }
  }

  if (result.verdict === "deny") {
    return mechanical(
      "deny",
      result,
      result.reason,
      result.audit.reasonCode,
      "deterministic-policy",
    );
  }
  if (result.verdict === "ask" && !isEscalated) {
    return mechanical(
      "ask",
      result,
      result.reason,
      result.audit.reasonCode,
      "deterministic-policy",
    );
  }

  const leadingCdTarget = leadingTrustedCdTarget(command);
  const parserUnverified =
    effectSandboxed &&
    (result.audit.basis === "parse-error" ||
      result.audit.basis === "depth-limit");
  const projectSensitiveMutation =
    !parserUnverified && hasProjectSensitiveMutation(command);
  if (
    !parserUnverified &&
    hasUnverifiedProjectMutationNavigation(
      command,
      leadingCdTarget !== undefined,
    ) &&
    !isEscalated
  ) {
    return mechanical(
      "ask",
      result,
      "プロジェクト変更前の作業場所を検証できないため確認が必要です",
      "mutation-navigation-unverified",
      "mutation-navigation",
    );
  }

  if (
    result.verdict === "allow" &&
    leadingCdTarget === undefined &&
    !projectSensitiveMutation &&
    !isEscalated
  ) {
    return mechanical(
      "allow",
      result,
      "command is mechanically allowed",
      result.audit.reasonCode,
      "deterministic-policy",
    );
  }

  if (
    !input.judgeAvailable &&
    leadingCdTarget === undefined &&
    !projectSensitiveMutation &&
    !isEscalated
  ) {
    return effectSandboxed && isSandboxResidualVerdict(result)
      ? mechanical(
          "ask",
          result,
          "Codex判定器が無効なため、sandbox内でも動的・不透明なコマンドには確認が必要です",
          "judge-disabled-sandbox-residual",
          "codex-judge",
        )
      : mechanical(
          "allow",
          result,
          "command does not require model routing",
          result.audit.reasonCode,
          "deterministic-policy",
        );
  }

  if (!input.projectResolved) {
    return {
      route: "context",
      requirement: "project",
      ...(leadingCdTarget === undefined ? {} : { target: leadingCdTarget }),
    };
  }

  const leadingNavigation =
    leadingCdTarget === undefined
      ? undefined
      : (input.leadingNavigation ?? input.project?.leadingNavigation);
  if (
    leadingCdTarget !== undefined &&
    !verifiedNavigation(leadingNavigation) &&
    !isEscalated
  ) {
    return mechanical(
      "ask",
      result,
      "登録済みの同一リポジトリworktreeへの移動と確認できませんでした",
      "leading-navigation-unverified",
      "leading-navigation",
    );
  }
  if (
    projectSensitiveMutation &&
    (input.project === undefined || input.project.kind === "unavailable") &&
    !isEscalated
  ) {
    return mechanical(
      "ask",
      result,
      "プロジェクト境界を検証できないため変更コマンドには確認が必要です",
      "project-mutation-unverified",
      "project-mutation",
    );
  }
  if (result.verdict === "allow" && !isEscalated) {
    return mechanical(
      "allow",
      result,
      "command is mechanically allowed",
      result.audit.reasonCode,
      "deterministic-policy",
    );
  }

  const trustedLeadingCdTarget = verifiedNavigation(leadingNavigation)
    ? leadingCdTarget
    : undefined;
  const trustedReadContext =
    input.project?.kind === "git"
      ? {
          cwd: trustedLeadingCdTarget ?? input.project.cwd,
          navigableRoots: input.project.navigableRoots,
        }
      : undefined;
  if (
    trustedLeadingCdTarget !== undefined ||
    trustedGitCwdTarget !== undefined ||
    trustedReadContext !== undefined
  ) {
    result = evaluate("verified-project", {
      ...evaluationOptions,
      ...(trustedLeadingCdTarget === undefined
        ? {}
        : { trustedLeadingCdTarget }),
      ...(trustedGitCwdTarget === undefined ? {} : { trustedGitCwdTarget }),
      ...(trustedReadContext === undefined ? {} : { trustedReadContext }),
    });
    if (result.verdict === "deny") {
      return mechanical(
        "deny",
        result,
        result.reason,
        result.audit.reasonCode,
        "deterministic-policy",
      );
    }
    if (result.verdict === "ask" && !isEscalated) {
      return mechanical(
        "ask",
        result,
        result.reason,
        result.audit.reasonCode,
        "deterministic-policy",
      );
    }
    if (result.verdict === "allow" && !isEscalated) {
      return mechanical(
        "allow",
        result,
        "command is mechanically allowed",
        result.audit.reasonCode,
        "deterministic-policy",
      );
    }
  }

  if (!input.judgeAvailable) {
    return mechanical(
      "ask",
      result,
      isEscalated
        ? "Codex判定器が無効なため自動承認できません"
        : "Codex判定器が無効なため、sandbox内でも動的・不透明なコマンドには確認が必要です",
      isEscalated ? "judge-disabled" : "judge-disabled-sandbox-residual",
      "codex-judge",
    );
  }

  return {
    route: "model",
    result,
    project: input.project,
    ...(leadingNavigation === undefined ? {} : { leadingNavigation }),
    ...(input.gitCwd === undefined ? {} : { gitCwd: input.gitCwd }),
  };
};
