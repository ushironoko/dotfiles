/**
 * pi-harness umbrella extension entry point.
 *
 * Single auto-discovery entry (~/.pi/agent/extensions/pi-harness/index.ts via
 * dotfiles symlink). Features are composed in an explicit order because pi
 * chains tool_call handlers in registration order: the permission policy must
 * evaluate before the hook bridge and everything else.
 *
 * In child pi processes (PI_HARNESS_CHILD=1) only the safety layer stays
 * active — see config.ts.
 */
import type { PiLike } from "./lib/pi-like";
import { loadConfig, type HarnessConfig } from "./config";
import setupPermissionPolicy from "./features/permission-policy/index";
import setupHookBridge from "./features/hook-bridge/index";
import setupSubagent from "./features/subagent/index";
import setupWorkflow from "./features/workflow/index";
import setupBitTask from "./features/bit-task/index";
import setupStatusline from "./features/statusline/index";
import setupProviderLog from "./features/provider-log/index";
import setupAsukuNotify from "./features/asuku-notify/index";
import setupAskUserQuestion from "./features/ask-user-question/index";
import setupChildRuns from "./features/child-runs/index";

// The parameter is typed against the narrowed PiLike seam instead of pi's
// ExtensionAPI: pi invokes this default export at runtime (jiti, no type
// boundary), and depending only on PiLike keeps pi 0.80.x API churn localized
// to lib/pi-like.ts. Shapes verified against tests/fixtures/pi-harness/raw/.
const setupHarness = (pi: PiLike, config: HarnessConfig): void => {
  // Safety floor first — never toggleable, present in child profiles too.
  setupPermissionPolicy(pi, config);

  // Reserve parent preflight before hook-bridge's async before_agent_start
  // work so a child completion cannot start a competing automatic turn.
  const childRuns =
    config.features.subagent || config.features.workflow
      ? setupChildRuns(pi)
      : undefined;
  if (config.features["hook-bridge"]) setupHookBridge(pi, config);
  if (config.features.subagent) setupSubagent(pi, config, { childRuns });
  if (config.features.workflow) setupWorkflow(pi, config, { childRuns });
  if (config.features["bit-task"]) setupBitTask(pi, config);
  if (config.features.statusline) setupStatusline(pi, config);
  if (config.features["provider-log"]) setupProviderLog(pi, config);
  if (config.features["asuku-notify"]) setupAsukuNotify(pi, config);
  if (config.features["ask-user-question"]) setupAskUserQuestion(pi);
};

const piHarness = (pi: PiLike): void => {
  setupHarness(pi, loadConfig());
};

export { setupHarness };
export default piHarness;
