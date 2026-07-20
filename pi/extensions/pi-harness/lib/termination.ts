/** Shared process-termination bounds used by lifecycle orchestration. */
export const PROCESS_FORCE_SETTLE_MS = 100;
export const WORKTREE_CREATE_TERM_GRACE_MS = 10_000;

// Lifecycle navigation must outwait the longest child cleanup contract so a
// cancelled create hook can publish its marker/path before archival. The
// headroom covers timer scheduling and local path validation after force-settle.
export const BACKGROUND_DRAIN_SCHEDULING_HEADROOM_MS = 1_900;
export const BACKGROUND_DRAIN_TIMEOUT_MS =
  WORKTREE_CREATE_TERM_GRACE_MS +
  PROCESS_FORCE_SETTLE_MS +
  BACKGROUND_DRAIN_SCHEDULING_HEADROOM_MS;
