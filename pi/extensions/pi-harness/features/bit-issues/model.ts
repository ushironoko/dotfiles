import { capUtf8, stripTerminalControls } from "../../lib/terminal-text";

export const BIT_ISSUE_DISPLAY_LIMIT = 100;
export const BIT_ISSUE_LIST_SENTINEL_LIMIT = BIT_ISSUE_DISPLAY_LIMIT + 1;
export const BIT_ISSUE_LIST_MAX_BYTES = 4 * 1024 * 1024;
export const BIT_ISSUE_DETAIL_MAX_BYTES = 1024 * 1024;
export const BIT_ISSUE_COMMENT_MAX_BYTES = 1024 * 1024;
export const BIT_ISSUE_STDERR_MAX_BYTES = 64 * 1024;
export const BIT_ISSUE_COMMAND_TIMEOUT_MS = 5_000;

const MAX_DATE_SECONDS = 8_640_000_000_000;

export type BitIssueState = "open" | "closed";

export interface BitIssueSummary {
  readonly id: string;
  readonly title: string;
  readonly state: BitIssueState;
  readonly author: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly labels: readonly string[];
}

export interface BitIssueDetail extends BitIssueSummary {
  readonly body: string;
}

export interface BitIssueListResult {
  readonly issues: readonly BitIssueSummary[];
  readonly truncated: boolean;
}

export type BitIssueComments =
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly text: string;
      readonly truncated: boolean;
    }
  | { readonly status: "error"; readonly message: string };

export interface BitIssueDetailResult {
  readonly issue: BitIssueDetail;
  readonly comments: BitIssueComments;
}

export type BitIssueFailureKind =
  | "aborted"
  | "command-failed"
  | "invalid-data"
  | "missing-bit"
  | "missing-git"
  | "non-git"
  | "oversize"
  | "timeout";

export class BitIssueCliError extends Error {
  constructor(
    readonly kind: BitIssueFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "BitIssueCliError";
  }
}

export interface BitIssueSnapshot {
  readonly issues: readonly BitIssueSummary[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error?: string;
  readonly refreshedAt?: number;
}

export type BitIssueDetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly detail: BitIssueDetailResult }
  | { readonly status: "error"; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new BitIssueCliError(
      "invalid-data",
      `bit issue field ${key} is not a string`,
    );
  }
  return value;
};

const requiredTimestamp = (
  record: Record<string, unknown>,
  key: string,
): number => {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_DATE_SECONDS
  ) {
    throw new BitIssueCliError(
      "invalid-data",
      `bit issue field ${key} is not a timestamp`,
    );
  }
  return value as number;
};

const decodeLabels = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((label) => typeof label !== "string")
  ) {
    throw new BitIssueCliError("invalid-data", "bit issue labels are invalid");
  }
  return value.map((label) =>
    capUtf8(stripTerminalControls(label as string, " "), 256),
  );
};

const decodeIssue = (value: unknown): BitIssueDetail => {
  if (!isRecord(value)) {
    throw new BitIssueCliError(
      "invalid-data",
      "bit issue JSON item is not an object",
    );
  }
  const id = requiredString(value, "id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new BitIssueCliError("invalid-data", "bit issue id is invalid");
  }
  const rawState = requiredString(value, "state");
  if (rawState !== "open" && rawState !== "closed") {
    throw new BitIssueCliError("invalid-data", "bit issue state is invalid");
  }
  return {
    id,
    title: capUtf8(
      stripTerminalControls(requiredString(value, "title"), " "),
      16 * 1024,
    ),
    state: rawState,
    author: capUtf8(
      stripTerminalControls(requiredString(value, "author"), " "),
      4 * 1024,
    ),
    createdAt: requiredTimestamp(value, "created_at"),
    updatedAt: requiredTimestamp(value, "updated_at"),
    labels: decodeLabels(value.labels),
    body: capUtf8(
      stripTerminalControls(requiredString(value, "body")),
      BIT_ISSUE_DETAIL_MAX_BYTES,
    ),
  };
};

const asSummary = (issue: BitIssueDetail): BitIssueSummary => ({
  id: issue.id,
  title: issue.title,
  state: issue.state,
  author: issue.author,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  labels: [...issue.labels],
});

export const decodeOpenBitIssueList = (value: unknown): BitIssueListResult => {
  if (!Array.isArray(value) || value.length > BIT_ISSUE_LIST_SENTINEL_LIMIT) {
    throw new BitIssueCliError(
      "invalid-data",
      "bit issue list JSON is invalid",
    );
  }
  const seen = new Set<string>();
  const open: BitIssueSummary[] = [];
  for (const item of value) {
    const issue = decodeIssue(item);
    if (seen.has(issue.id)) {
      throw new BitIssueCliError(
        "invalid-data",
        `duplicate bit issue id: ${issue.id}`,
      );
    }
    seen.add(issue.id);
    if (issue.state === "open") open.push(asSummary(issue));
  }
  open.sort((left, right) => {
    const updatedOrder = right.updatedAt - left.updatedAt;
    if (updatedOrder !== 0) return updatedOrder;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  return {
    issues: open.slice(0, BIT_ISSUE_DISPLAY_LIMIT),
    truncated: open.length > BIT_ISSUE_DISPLAY_LIMIT,
  };
};

export const decodeBitIssueDetail = (value: unknown): BitIssueDetail =>
  decodeIssue(value);
