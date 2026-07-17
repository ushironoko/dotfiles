import type { ComponentLike } from "./presentation";

export interface FocusTuiLike {
  setFocus?(component: ComponentLike | null): void;
}

interface PrivateFocusTuiLike extends FocusTuiLike {
  focusedComponent?: unknown;
}

export type FocusReadResult =
  | { supported: true; component: ComponentLike | null }
  | { supported: false; reason: string };

const isComponentLike = (value: unknown): value is ComponentLike =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { render?: unknown }).render === "function" &&
  typeof (value as { invalidate?: unknown }).invalidate === "function";

/**
 * The only adapter allowed to inspect pi-tui's private focus state.
 *
 * `setFocus` is public, but pi 0.80.x has no public focus getter. Callers must
 * treat any failed read as a permanent capability loss and stop consuming
 * editor input; a missing restoration target must never be guessed.
 */
export const readFocusedComponent = (tui: FocusTuiLike): FocusReadResult => {
  if (typeof tui.setFocus !== "function") {
    return { supported: false, reason: "TUI setFocus is unavailable" };
  }

  try {
    if (!("focusedComponent" in tui)) {
      return {
        supported: false,
        reason: "TUI focus inspection is unavailable",
      };
    }
    const component = (tui as PrivateFocusTuiLike).focusedComponent;
    if (component === null || component === undefined) {
      return { supported: true, component: null };
    }
    if (!isComponentLike(component)) {
      return { supported: false, reason: "TUI focus target has changed shape" };
    }
    return { supported: true, component };
  } catch {
    return { supported: false, reason: "TUI focus inspection failed" };
  }
};

export const setFocusSafely = (
  tui: FocusTuiLike,
  component: ComponentLike | null,
): { ok: true } | { ok: false; reason: string } => {
  if (typeof tui.setFocus !== "function") {
    return { ok: false, reason: "TUI setFocus is unavailable" };
  }
  try {
    tui.setFocus(component);
    return { ok: true };
  } catch {
    return { ok: false, reason: "TUI focus change failed" };
  }
};
