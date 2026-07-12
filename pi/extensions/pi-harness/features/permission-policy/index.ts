import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PiLike } from "../../lib/pi-like";
import type { HarnessConfig } from "../../config";
import { evaluateCommand, loadRules } from "./rules";

const readPermissionRules = (): string | undefined => {
  try {
    const rulesFile = fileURLToPath(
      new URL("../../permission-rules.json", import.meta.url),
    );
    return readFileSync(rulesFile, "utf8");
  } catch {
    return undefined;
  }
};

const MALFORMED_REASON =
  "permission-policy: bash ツール入力が不正なため実行をブロックしました（command が文字列ではありません）";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const setupPermissionPolicy = (pi: PiLike, _config: HarnessConfig): void => {
  const rules = loadRules(readPermissionRules());

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    try {
      const input: unknown = event.input;
      const command = isRecord(input) ? input.command : undefined;
      // A bash call whose command is missing or not a string is malformed;
      // the safety floor blocks it instead of letting it through (fail-closed).
      if (typeof command !== "string") {
        return { block: true, reason: MALFORMED_REASON };
      }

      const result = evaluateCommand(command, rules);
      if (result.verdict === "deny") {
        return { block: true, reason: result.reason };
      }
      if (result.verdict !== "ask") return undefined;
      if (!ctx.hasUI) return { block: true, reason: result.reason };

      const confirmed = await ctx.ui.confirm(
        "危険なコマンドを実行しますか？",
        `${result.reason}\n\n${command}`,
      );
      return confirmed ? undefined : { block: true, reason: result.reason };
    } catch (error) {
      // Any evaluation failure blocks rather than failing open.
      return {
        block: true,
        reason: `permission-policy: 評価中にエラーが発生したためブロックしました (${String(error)})`,
      };
    }
  });
};

export default setupPermissionPolicy;
