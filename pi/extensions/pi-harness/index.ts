/**
 * pi-harness umbrella extension entry point.
 *
 * Single auto-discovery entry (~/.pi/agent/extensions/pi-harness/index.ts via
 * dotfiles symlink). Features are composed in an explicit order because pi
 * chains tool_call handlers in registration order. The non-executing npm
 * script-preference rejection may short-circuit first; every command it does
 * not block then reaches the mandatory permission policy before other hooks.
 *
 * In child pi processes (PI_HARNESS_CHILD=1) only the safety layer stays
 * active — see config.ts.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { delimiter, join } from "node:path";
import type { PiLike } from "./lib/pi-like";
import { loadConfig, type HarnessConfig } from "./config";
import setupBashSandboxFeature from "./features/bash-sandbox/index";
import setupPermissionPolicy from "./features/permission-policy/index";
import {
  consumeCodexStageCapability,
  createCodexStageExecutablePin,
} from "./features/permission-policy/codex-stage-capability";
import { createPermissionTaskTracker } from "./features/permission-policy/context";
import { setupPermissionAudit } from "./features/permission-audit/index";
import {
  createPermissionBlocker,
  type PermissionBlockerOptions,
} from "./features/permission-policy/block";
import setupHookBridge from "./features/hook-bridge/index";
import setupGitHubCliReminder from "./features/github-cli-reminder/index";
import setupProgressReminder from "./features/progress-reminder/index";
import setupPermissionAskReminder from "./features/permission-ask-reminder/index";
import {
  buildRegistry,
  partitionBridgeRegistry,
} from "./features/hook-bridge/registry";
import setupSubagent from "./features/subagent/index";
import setupWorkflow from "./features/workflow/index";
import setupBitTask from "./features/bit-task/index";
import setupAgentMemory from "./features/agent-memory/index";
import { AgentMemoryRegistry } from "./features/agent-memory/registry";
import setupStatusline from "./features/statusline/index";
import setupProviderLog from "./features/provider-log/index";
import setupAsukuNotify from "./features/asuku-notify/index";
import setupAskUserQuestion from "./features/ask-user-question/index";
import setupBtw from "./features/btw/index";
import setupChildRuns from "./features/child-runs/index";

// This hook runs before the permission boundary, so it must not resolve any
// executable through an inherited repository-influenced PATH. If a required
// utility is absent from these root-owned system directories, the hook fails
// closed into permission-policy instead of consulting a user-writable path.
const PERMISSION_PREFLIGHT_PATH = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(delimiter);

// The parameter is typed against the narrowed PiLike seam instead of pi's
// ExtensionAPI: pi invokes this default export at runtime (jiti, no type
// boundary), and depending only on PiLike keeps pi 0.80.x API churn localized
// to lib/pi-like.ts. Shapes verified against tests/fixtures/pi-harness/raw/.
interface SetupHarnessOptions extends PermissionBlockerOptions {
  readonly setupBashSandbox?: typeof setupBashSandboxFeature;
  readonly consumeCodexStageCapability?: typeof consumeCodexStageCapability;
  readonly createCodexStageExecutablePin?: typeof createCodexStageExecutablePin;
}

const setupHarness = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupHarnessOptions = {},
): void => {
  const {
    setupBashSandbox: createBashSandbox = setupBashSandboxFeature,
    consumeCodexStageCapability:
      consumeCodexStageModes = consumeCodexStageCapability,
    createCodexStageExecutablePin:
      createCodexStagePin = createCodexStageExecutablePin,
    ...blockerOptions
  } = options;
  // Install (or, when disabled after /reload, remove) the shared confirmation
  // adapter before any permission handler can call ctx.ui.confirm. The bridge
  // remains best-effort and preserves the original TUI dialog on failure.
  setupAsukuNotify(pi, config);
  let codexStageModes = consumeCodexStageModes(config.isChild);
  let codexStageExecutable:
    | ReturnType<typeof createCodexStageExecutablePin>
    | undefined;
  if (codexStageModes.size > 0) {
    try {
      codexStageExecutable = createCodexStagePin(
        join(config.paths.claudeHooksDir, "lib", "codex-stage.sh"),
      );
    } catch {
      // The managed bypass is optional; the mandatory permission policy is
      // not. Disable the capability and continue registering the normal
      // fail-closed boundary when launcher pinning is unavailable.
      codexStageModes = new Set();
    }
  }
  if (codexStageExecutable !== undefined) {
    pi.on("session_shutdown", () => codexStageExecutable.dispose());
  }
  // One blocker owns the child authenticator for every permission handler.
  // This preserves the parent observer's failure classification even when a
  // bridge hook rejects before (or after) the mandatory policy handler.
  const blockToolCall = createPermissionBlocker(config.isChild, blockerOptions);
  const permissionTaskTracker = createPermissionTaskTracker();
  const permissionAskReminder = config.isChild
    ? undefined
    : setupPermissionAskReminder(pi);
  // Bash sandbox setup does not register its execution-boundary tool_call
  // handler yet, so the audit starter below remains the first Bash observer.
  // Creating the controller first lets audit begin capture the authenticated
  // profile fingerprint even when an earlier preflight hook blocks the call.
  const bashSandbox = createBashSandbox(pi, config);
  const permissionAudit = setupPermissionAudit(pi, config, {
    taskTracker: permissionTaskTracker,
    onDisplayedConfirmation: permissionAskReminder?.recordDisplayedConfirmation,
    executionBoundary: (toolName) => bashSandbox.boundaryFor(toolName),
  });
  const bridgeRegistry = config.features["hook-bridge"]
    ? partitionBridgeRegistry(buildRegistry(config.paths))
    : undefined;

  // Reserve the parent turn before either hook-bridge partition registers its
  // async before_agent_start handler. This manager has no tool_call handler, so
  // the npm preflight still remains first in the command-permission chain.
  const agentMemory =
    config.features["agent-memory"] && !config.isChild
      ? new AgentMemoryRegistry({ trust: config.trust })
      : undefined;
  const childRuns =
    config.features.subagent ||
    config.features.workflow ||
    config.features["bit-task"] ||
    agentMemory !== undefined
      ? setupChildRuns(pi, {
          bitIssues: config.features["bit-task"],
          agentMemory,
          childExecution: config.features.subagent || config.features.workflow,
          maxConcurrentChildren: config.childRuns?.maxConcurrent,
        })
      : undefined;

  // Parent turns receive hidden user-facing guidance. Child processes omit it
  // because their progress is reported through the parent orchestrator.
  if (!config.isChild) {
    setupGitHubCliReminder(pi);
    setupProgressReminder(pi);
  }

  // Reject package runners with an equivalent project script before the local
  // judge can ask. A hook pass, timeout, or error still falls through to the
  // mandatory safety floor; a block cannot execute anything and short-circuits.
  if (bridgeRegistry?.permissionPreflight.length) {
    setupHookBridge(pi, config, {
      registry: bridgeRegistry.permissionPreflight,
      env: { PATH: PERMISSION_PREFLIGHT_PATH },
      blockToolCall,
      permissionAudit,
      auditPhase: "preflight",
    });
  }

  // Safety floor before every path that can continue to tool execution.
  setupPermissionPolicy(pi, config, {
    blockToolCall,
    taskTracker: permissionTaskTracker,
    permissionAudit,
    executionBoundary: (toolName) => bashSandbox.boundaryFor(toolName),
    codexStageModes,
    codexStageExecutablePath: codexStageExecutable?.executablePath,
  });

  if (bridgeRegistry?.remaining.length) {
    setupHookBridge(pi, config, {
      registry: bridgeRegistry.remaining,
      blockToolCall,
      permissionAudit,
      auditPhase: "remaining",
    });
  }
  // Every policy/hook above inspected the original command. Only now replace
  // ordinary Bash with the OS-sandbox wrapper; audit release is recorded after
  // successful readiness/wrapping and immediately before controlled execution.
  bashSandbox.registerExecutionBoundary({ blockToolCall, permissionAudit });
  permissionAudit.registerTail(pi, blockToolCall);
  if (config.features.subagent) {
    setupSubagent(pi, config, { childRuns, permissionAudit });
  }
  if (config.features.workflow) {
    setupWorkflow(pi, config, {
      childRuns,
      permissionAudit,
      onWorktreeCreated: (path) => bashSandbox.registerWritableWorktree(path),
    });
  }
  if (config.features["bit-task"]) {
    setupBitTask(pi, config, {
      onWorktreeCreated: (path) => bashSandbox.registerWritableWorktree(path),
      onWorktreeRemoved: (path) => bashSandbox.revokeWritableWorktree(path),
    });
  }
  if (config.features["agent-memory"])
    setupAgentMemory(
      pi,
      config,
      agentMemory === undefined ? {} : { registry: agentMemory },
    );
  if (config.features.statusline) setupStatusline(pi, config);
  if (config.features["provider-log"]) setupProviderLog(pi, config);
  if (config.features["ask-user-question"]) setupAskUserQuestion(pi);
  if (!config.isChild) setupBtw(pi);
};

const piHarness: ExtensionFactory = (pi): void => {
  setupHarness(pi, loadConfig());
};

export { PERMISSION_PREFLIGHT_PATH, setupHarness };
export default piHarness;
