import { expect, test } from "bun:test";
import { loadConfig } from "../../pi/extensions/pi-harness/config";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import {
  cleanupTestDirectory,
  createTestFile,
  setupTestDirectory,
} from "../test-helpers";

test("ships the GitHub network allowlist as a global default", async () => {
  const home = await setupTestDirectory("pi-bash-sandbox-config");
  const paths = resolvePaths(home);

  try {
    expect(loadConfig({}, paths).bashSandbox?.network.allowedDomains).toEqual([
      "api.github.com",
      "github.com",
    ]);

    await createTestFile(
      paths.localConfigFile,
      JSON.stringify({
        bashSandbox: {
          network: { allowedDomains: ["uploads.github.com"] },
        },
      }),
    );

    expect(loadConfig({}, paths).bashSandbox?.network.allowedDomains).toEqual([
      "api.github.com",
      "github.com",
      "uploads.github.com",
    ]);
  } finally {
    await cleanupTestDirectory(home);
  }
});
