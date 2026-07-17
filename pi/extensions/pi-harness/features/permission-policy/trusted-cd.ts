import { isAbsolute } from "node:path";
import { validateCwdInSameRepo } from "../../lib/repo-boundary";
import { normalizeSegment, scanCommand, type Segment } from "./scan";

/**
 * Return the literal target of the one cd shape that may become neutral.
 *
 * This intentionally recognizes less than Bash supports: the first simple
 * command must be a top-level, redirect-free `cd <absolute-path>` followed by
 * `&&`. Options, wrappers, assignments, expansions, relative paths, additional
 * operands, and other connectors stay on the ordinary judge path.
 */
export const literalTrustedCdTarget = (
  segment: Segment,
): string | undefined => {
  if (
    !segment.topLevel ||
    !segment.followedByAnd ||
    segment.allowCandidate === undefined ||
    segment.words.length !== 2 ||
    segment.words[0] !== "cd" ||
    segment.opaque.size !== 0
  ) {
    return undefined;
  }

  const [, target] = segment.words;
  return target !== undefined && isAbsolute(target) ? target : undefined;
};

/**
 * Find a single leading literal cd and verify that it belongs to the same Git
 * common directory as the Bash tool cwd. Equal common-dir identity admits both
 * ordinary subdirectories and linked worktrees without admitting unrelated or
 * nested repositories.
 */
export const resolveTrustedLeadingCd = async (
  command: string,
  cwd: string,
): Promise<string | undefined> => {
  try {
    const scanned = scanCommand(command);
    if (!scanned.ok || scanned.segments.length < 2) return undefined;

    const cdSegments = scanned.segments.filter(
      (segment) => normalizeSegment(segment).words[0] === "cd",
    );
    if (cdSegments.length !== 1 || cdSegments[0] !== scanned.segments[0]) {
      return undefined;
    }

    const target = literalTrustedCdTarget(cdSegments[0]);
    if (target === undefined) return undefined;

    const boundary = await validateCwdInSameRepo(target, cwd);
    return boundary.ok ? target : undefined;
  } catch {
    // Boundary discovery is an approval optimization. Any uncertainty falls
    // back to the existing local judge instead of blocking or failing open.
    return undefined;
  }
};
