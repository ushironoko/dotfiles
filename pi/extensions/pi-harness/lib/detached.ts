/**
 * Fire-and-forget process launcher for side-effect features (asuku-notify,
 * statusline). The child is detached from pi's process group, all output is
 * discarded, and every failure is swallowed — a notifier or cache refresh
 * must never surface as an error in the conversation.
 */
import { spawn } from "node:child_process";

export interface DetachedSpawnOptions {
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export type DetachedSpawnFunction = (
  command: string,
  args: string[],
  options: DetachedSpawnOptions,
) => void;

export const launchDetached: DetachedSpawnFunction = (
  command,
  args,
  options,
) => {
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [
        options.stdin === undefined ? "ignore" : "pipe",
        "ignore",
        "ignore",
      ],
    });
    child.on("error", () => {
      // Fire-and-forget: launch failures must stay invisible.
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {
        // The child may exit before consuming stdin (EPIPE); ignore.
      });
      child.stdin.end(options.stdin);
    }
    child.unref();
  } catch {
    // Fire-and-forget: synchronous spawn failures must stay invisible.
  }
};
