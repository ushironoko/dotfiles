#!/usr/bin/env bash
# Fail-closed guard for hooks that would execute repository-defined commands.

codex_project_is_trusted() {
  local candidate=${1:-} config_path
  [ -n "$candidate" ] && [ -d "$candidate" ] || return 1
  command -v bun >/dev/null 2>&1 || return 1

  if [ -n "${CODEX_CONFIG_PATH:-}" ]; then
    config_path=$CODEX_CONFIG_PATH
  elif [ -n "${CODEX_HOME:-}" ]; then
    config_path=$CODEX_HOME/config.toml
  elif [ -n "${HOME:-}" ]; then
    config_path=$HOME/.codex/config.toml
  else
    return 1
  fi
  [ -r "$config_path" ] || return 1

  CODEX_TRUST_CONFIG=$config_path CODEX_TRUST_CANDIDATE=$candidate bun -e '
    import { realpathSync } from "node:fs";
    import { homedir } from "node:os";
    import { isAbsolute, sep } from "node:path";

    const configPath = process.env.CODEX_TRUST_CONFIG ?? "";
    const candidatePath = process.env.CODEX_TRUST_CANDIDATE ?? "";
    try {
      const parsed = Bun.TOML.parse(await Bun.file(configPath).text());
      const projects = parsed.projects;
      if (typeof projects !== "object" || projects === null) process.exit(1);
      const candidate = realpathSync(candidatePath);
      for (const [configuredPath, settings] of Object.entries(projects)) {
        if (typeof settings !== "object" || settings === null) continue;
        if (settings.trust_level !== "trusted") continue;
        const expanded = configuredPath.startsWith("~/")
          ? homedir() + configuredPath.slice(1)
          : configuredPath;
        if (!isAbsolute(expanded)) continue;
        let trustedRoot;
        try {
          trustedRoot = realpathSync(expanded);
        } catch {
          continue;
        }
        if (candidate === trustedRoot || candidate.startsWith(trustedRoot + sep)) {
          process.exit(0);
        }
      }
    } catch {}
    process.exit(1);
  ' >/dev/null 2>&1
}
