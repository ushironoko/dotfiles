import { describe, expect, test } from "bun:test";

import { renderExtensionStatuses } from "../../pi/extensions/pi-harness/features/statusline/render";

describe("statusline extension status visibility", () => {
  test("hides bash sandbox status while preserving unrelated statuses", () => {
    const statuses = new Map([
      ["bash-sandbox", "sandbox: denied, 3 write roots"],
      ["other-extension", "other: busy"],
    ]);

    expect(renderExtensionStatuses(statuses, 80)).toBe("other: busy");
  });

  test("omits the extension status line when sandbox is the only status", () => {
    const statuses = new Map([
      ["bash-sandbox", "sandbox: allowlisted, 4 write roots"],
    ]);

    expect(renderExtensionStatuses(statuses, 80)).toBeUndefined();
  });
});
