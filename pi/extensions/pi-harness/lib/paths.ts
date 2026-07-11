/**
 * Path resolution with an injectable HOME so tests can point the harness at a
 * temporary directory instead of the real user profile.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface HarnessPaths {
  home: string;
  claudeHooksDir: string;
  claudeAgentsDir: string;
  codexHooksDir: string;
  localConfigFile: string;
  logDir: string;
}

export function resolvePaths(home: string = homedir()): HarnessPaths {
  return {
    home,
    claudeHooksDir: join(home, ".claude", "hooks"),
    claudeAgentsDir: join(home, ".claude", "agents"),
    codexHooksDir: join(home, ".codex", "hooks"),
    localConfigFile: join(home, ".pi", "agent", "pi-harness.local.json"),
    logDir: join(home, ".pi", "agent", "pi-harness", "logs"),
  };
}
