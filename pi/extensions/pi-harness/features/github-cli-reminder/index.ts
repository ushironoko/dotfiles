import type { PiLike } from "../../lib/pi-like";

const GITHUB_CLI_REMINDER_TYPE = "pi-harness-github-cli-reminder" as const;

const GITHUB_CLI_REMINDER = `<system-reminder>
When inspecting GitHub repositories, issues, or pull requests, use the gh CLI through the bash tool:
- GitHub repositories: \`gh repo view\`
- GitHub issues: \`gh issue view\` / \`gh issue list\`
- GitHub pull requests: \`gh pr view\` / \`gh pr list\`
- Advanced GitHub API access: \`gh api\`

Do not use web_fetch for GitHub repository metadata, issues, or pull requests.
Use web_fetch only for non-GitHub public web pages.
Use the git CLI as needed to inspect local repository state.
</system-reminder>`;

interface SessionContextLike {
  sessionManager?: {
    buildContextEntries(): unknown;
  };
}

const reminderInActiveContext = (ctx: unknown): boolean | undefined => {
  const { sessionManager } = ctx as SessionContextLike;
  if (sessionManager === undefined) return undefined;

  try {
    const entries = sessionManager.buildContextEntries();
    if (!Array.isArray(entries)) return undefined;
    return entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "custom_message" &&
        "customType" in entry &&
        entry.customType === GITHUB_CLI_REMINDER_TYPE,
    );
  } catch {
    return undefined;
  }
};

/** Keep GitHub inspection guidance in parent context without per-turn copies. */
const setupGitHubCliReminder = (pi: PiLike): void => {
  // Only test/legacy adapters lack SessionManager. Real pi derives presence
  // from the active branch so resume, reload, compaction, and tree navigation
  // neither duplicate a persisted reminder nor lose one on an older branch.
  let injectedWithoutSessionState = false;

  pi.on("before_agent_start", (_event, ctx) => {
    const persisted = reminderInActiveContext(ctx);
    if (persisted ?? injectedWithoutSessionState) return undefined;
    injectedWithoutSessionState = true;
    return {
      message: {
        customType: GITHUB_CLI_REMINDER_TYPE,
        content: GITHUB_CLI_REMINDER,
        display: false,
      },
    };
  });

  // Let adapters without SessionManager model a context boundary in tests.
  pi.on("session_compact", () => {
    injectedWithoutSessionState = false;
  });
};

export {
  GITHUB_CLI_REMINDER,
  GITHUB_CLI_REMINDER_TYPE,
  setupGitHubCliReminder as default,
};
