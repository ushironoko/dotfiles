import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLocalPiBaseline,
  checkLocalPiBaseline,
  PI_BASELINE_PACKAGES,
} from "../../scripts/pi-compat/baseline";

const roots: string[] = [];
const versions: Record<(typeof PI_BASELINE_PACKAGES)[number], string> = {
  "@earendil-works/pi-coding-agent": "1.2.3",
  "@earendil-works/pi-ai": "1.2.3",
  "@earendil-works/pi-agent-core": "1.2.3",
  "@earendil-works/pi-tui": "1.2.3",
  typebox: "9.8.7",
};

const setupBaseline = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-baseline-"));
  roots.push(root);

  const direct = {
    "@earendil-works/pi-coding-agent": "1.2.3",
    "@earendil-works/pi-ai": "1.2.3",
    "@earendil-works/pi-tui": "1.2.3",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: direct }),
  );
  const packages = Object.fromEntries(
    PI_BASELINE_PACKAGES.map((name) => [name, [`${name}@${versions[name]}`]]),
  );
  await writeFile(
    join(root, "bun.lock"),
    JSON.stringify({
      workspaces: { "": { devDependencies: direct } },
      packages,
    }),
  );

  for (const name of PI_BASELINE_PACKAGES) {
    const packageRoot = join(root, "node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version: versions[name] }),
    );
  }
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("local pi baseline", () => {
  test("accepts a coherent direct pin, lock, and installed cohort", async () => {
    const root = await setupBaseline();
    const result = await checkLocalPiBaseline(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.packages.map((item) => item.name)).toEqual([
      ...PI_BASELINE_PACKAGES,
    ]);
  });

  test("reports direct pin, lock, and stale installed tree separately", async () => {
    const root = await setupBaseline();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@earendil-works/pi-coding-agent": "2.0.0",
          "@earendil-works/pi-ai": "1.2.3",
        },
      }),
    );
    await writeFile(
      join(root, "node_modules/@earendil-works/pi-ai/package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-ai",
        version: "1.2.2",
      }),
    );

    const result = await checkLocalPiBaseline(root);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain(
      "lock-pin: @earendil-works/pi-coding-agent",
    );
    expect(result.issues.join("\n")).toContain(
      "direct-pin: @earendil-works/pi-tui",
    );
    expect(result.issues.join("\n")).toContain(
      "installed-tree: @earendil-works/pi-ai",
    );
  });

  test("rejects non-exact direct pins and resolved versions that differ", async () => {
    const root = await setupBaseline();
    const direct = {
      "@earendil-works/pi-coding-agent": "^1.2.3",
      "@earendil-works/pi-ai": "1.2.3",
      "@earendil-works/pi-tui": "1.2.3",
    };
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: direct }),
    );
    const resolved = {
      ...versions,
      "@earendil-works/pi-coding-agent": "1.2.4",
    };
    await writeFile(
      join(root, "bun.lock"),
      JSON.stringify({
        workspaces: { "": { devDependencies: direct } },
        packages: Object.fromEntries(
          PI_BASELINE_PACKAGES.map((name) => [
            name,
            [`${name}@${resolved[name]}`],
          ]),
        ),
      }),
    );
    await writeFile(
      join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "1.2.4",
      }),
    );

    const checked = await checkLocalPiBaseline(root);
    expect(checked.issues.join("\n")).toContain("must use an exact version");
    expect(checked.issues.join("\n")).toContain("resolved-pin:");
  });

  test("fails with frozen-install remediation", async () => {
    const root = await setupBaseline();
    await rm(join(root, "node_modules/typebox"), { recursive: true });
    await expect(assertLocalPiBaseline(root)).rejects.toThrow(
      "bun install --frozen-lockfile",
    );
  });
});
