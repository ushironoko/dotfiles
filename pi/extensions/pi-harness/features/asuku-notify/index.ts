/**
 * asuku-notify feature — feeds the asuku desktop notifier when the agent
 * settles, following the codex stop/asuku_notification.sh contract: the
 * notifier runs detached with the payload on stdin, all output discarded,
 * and a missing or non-executable binary is silently skipped.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { HarnessConfig } from "../../config";
import { launchDetached, type DetachedSpawnFunction } from "../../lib/detached";
import type { PiLike } from "../../lib/pi-like";

const ASUKU_BINARY = "/Applications/asuku.app/Contents/MacOS/asuku-hook";

interface AsukuNotifyDeps {
  binaryPath?: string;
  spawnDetached?: DetachedSpawnFunction;
}

export default function setupAsukuNotify(
  pi: PiLike,
  _config: HarnessConfig,
  deps: AsukuNotifyDeps = {},
): void {
  const binary = deps.binaryPath ?? ASUKU_BINARY;
  const spawnDetached = deps.spawnDetached ?? launchDetached;

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      await access(binary, constants.X_OK);
    } catch {
      return;
    }
    const cwd = ctx.cwd ?? process.cwd();
    const payload = JSON.stringify({
      hook_event_name: "Notification",
      session_id: "pi-harness",
      cwd,
      message: "pi agent finished its turn",
    });
    spawnDetached(binary, ["notification"], { cwd, stdin: payload });
  });
}
