import type {
  PermissionLeadingNavigation,
  PermissionRunEvidence,
} from "../permission-policy/context";
import type {
  PermissionNavigationAuditContext,
  PermissionRunAuditContext,
} from "./model";

/**
 * Copies only fields owned by the persisted audit schema. Runtime evidence may
 * evolve independently without implicitly expanding private JSONL records.
 */
export const projectPermissionRunEvidence = (
  evidence: PermissionRunEvidence | undefined,
): PermissionRunAuditContext | undefined => {
  if (evidence === undefined) return undefined;
  return {
    ...(evidence.assistantText === undefined
      ? {}
      : { assistantText: evidence.assistantText }),
    ...(evidence.askUserQuestionResultText === undefined
      ? {}
      : { askUserQuestionResultText: evidence.askUserQuestionResultText }),
    priorToolResults: evidence.priorToolResults.map((result) => ({
      toolName: result.toolName,
      status: result.status,
    })),
    fingerprint: evidence.fingerprint,
  };
};

/** Projects precomputed navigation scope without persisting future metadata. */
export const projectPermissionNavigation = (
  navigation: PermissionLeadingNavigation | undefined,
): PermissionNavigationAuditContext | undefined =>
  navigation === undefined
    ? undefined
    : {
        scope: navigation.scope,
        sameRepository: navigation.sameRepository,
      };
