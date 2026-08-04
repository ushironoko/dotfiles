import { expect, test } from "bun:test";
import {
  DEFAULT_CHILD_RUNS_CONFIG,
  loadConfig,
} from "../../pi/extensions/pi-harness/config";
import {
  MAX_CONCURRENT_CHILDREN,
  MIN_CONCURRENT_CHILDREN,
} from "../../pi/extensions/pi-harness/features/child-runs/limits";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import {
  cleanupTestDirectory,
  createTestFile,
  setupTestDirectory,
} from "../test-helpers";

test("defaults child-run concurrency high enough for 30+ agent workflows", async () => {
  const home = await setupTestDirectory("pi-child-run-config-default");
  try {
    const config = loadConfig({}, resolvePaths(home)).childRuns;
    expect(config).toEqual(DEFAULT_CHILD_RUNS_CONFIG);
    expect(config?.maxConcurrent).toBeGreaterThan(30);
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("accepts a bounded machine-local child-run concurrency override", async () => {
  const home = await setupTestDirectory("pi-child-run-config-override");
  const paths = resolvePaths(home);
  try {
    await createTestFile(
      paths.localConfigFile,
      JSON.stringify({ childRuns: { maxConcurrent: 48 } }),
    );
    expect(loadConfig({}, paths).childRuns).toEqual({ maxConcurrent: 48 });
  } finally {
    await cleanupTestDirectory(home);
  }
});

test.each([
  MIN_CONCURRENT_CHILDREN - 1,
  MAX_CONCURRENT_CHILDREN + 1,
  1.5,
  "32",
  null,
])("rejects invalid child-run concurrency %j", async (maxConcurrent) => {
  const home = await setupTestDirectory("pi-child-run-config-invalid");
  const paths = resolvePaths(home);
  try {
    await createTestFile(
      paths.localConfigFile,
      JSON.stringify({ childRuns: { maxConcurrent } }),
    );
    const config = loadConfig({}, paths);
    expect(config.childRuns).toEqual({
      ...DEFAULT_CHILD_RUNS_CONFIG,
      configurationError: "invalid childRuns fields: maxConcurrent",
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});
