import { describe, expect, test } from "bun:test";
import theme from "../../pi/themes/transparent-dark.json";

const TRANSPARENT_BACKGROUND_KEYS = [
  "selectedBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

describe("transparent pi theme", () => {
  test("keeps only the user-message background opaque", () => {
    expect(theme.vars.transparent).toBe("");
    expect(theme.vars.userMsgBg).toBe("#303354");
    expect(theme.colors.userMessageBg).toBe("userMsgBg");

    for (const key of TRANSPARENT_BACKGROUND_KEYS) {
      expect(theme.colors[key]).toBe("transparent");
    }
  });

  test("uses the requested semantic and path colors", () => {
    expect(theme.vars.success).toBe("#01ac5e");
    expect(theme.vars.error).toBe("#e33830");
    expect(theme.vars.accent).toBe("#0075c2");
    expect(theme.colors.success).toBe("success");
    expect(theme.colors.error).toBe("error");
    expect(theme.colors.accent).toBe("accent");
  });

  test("uses the requested skill label color", () => {
    expect(theme.colors.customMessageBg).toBe("transparent");
    expect(theme.colors.customMessageLabel).toBe("#ededed");
  });
});
