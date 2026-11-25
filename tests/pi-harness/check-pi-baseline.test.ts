import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertLocalPiBaseline,
  checkLocalPiBaseline,
} from "../../scripts/pi-compat/baseline";

const roots: string[] = [];
const versions = {
  "@earendil-works/pi-coding-agent": "1.6.0",
  "@earendil-works/pi-ai": "1.6.0",
  "@earendil-works/pi-agent-core": "1.6.0",
  "@earendil-works/pi-codemode": "1.6.0",
  "@earendil-works/pi-mcp": "1.6.0",
  "@earendil-works/pi-telemetry": "1.6.0",
  "@earendil-works/pi-tui": "1.6.0",
  "@earendil-works/pi-schema": "1.6.0",
  typebox: "1.3.27",
};

const setupBaseline = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-baseline-"));
  roots.push(root);

  const direct = {
    "@earendil-works/pi-coding-agent": "1.6.0",
    "@earendil-works/pi-ai": "1.6.0",
    "@earendil-works/pi-tui": "1.6.0",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: direct }),
  );
  const packages = Object.fromEntries(
    Object.entries(versions).map(([name, version]) => [
      name,
      [`${name}@${version}`],
    ]),
  );
  await writeFile(
    join(root, "bun.lock"),
    JSON.stringify({
      workspaces: { "": { devDependencies: direct } },
      packages,
    }),
  );

  for (const [name, version] of Object.entries(versions)) {
    const packageRoot = join(root, "node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  return root;
};

const isolatePackage = async (
  root: string,
  name: string,
  version: string,
  exposure = "node_modules",
): Promise<string> => {
  const modules = join(root, "node_modules");
  const exposed = join(modules, name);
  const store = `${name.replace("/", "+")}@${version}`;
  const installed = join(modules, ".bun", store, "node_modules", name);
  await mkdir(dirname(installed), { recursive: true });
  await rename(exposed, installed);
  const linked = join(root, exposure, name);
  await mkdir(dirname(linked), { recursive: true });
  await symlink(installed, linked, "dir");
  return installed;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("local pi baseline", () => {
  test("accepts Pi 1.6.0 with transitive pi-schema and no chord", async () => {
    const root = await setupBaseline();
    const result = await checkLocalPiBaseline(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(
      Object.fromEntries(
        result.packages.map(({ name, lockedVersion }) => [name, lockedVersion]),
      ),
    ).toEqual(versions);
  });

  test("accepts the local cohort exposed by Bun's isolated layout", async () => {
    const root = await setupBaseline();
    const direct = new Set(
      ["pi-coding-agent", "pi-ai", "pi-tui"].map(
        (name) => `@earendil-works/${name}`,
      ),
    );
    const installed = await Promise.all(
      Object.entries(versions).map(async ([name, version]) => [
        name,
        await realpath(
          await isolatePackage(
            root,
            name,
            version,
            direct.has(name)
              ? "node_modules"
              : "node_modules/.bun/node_modules",
          ),
        ),
      ]),
    );
    const result = await assertLocalPiBaseline(root);
    expect(
      Object.fromEntries(
        result.packages.map(({ name, installedRoot }) => [name, installedRoot]),
      ),
    ).toEqual(Object.fromEntries(installed));
  });

  test("requires a direct Pi pin to be exposed at the project root", async () => {
    const root = await setupBaseline();
    const name = "@earendil-works/pi-tui";
    await isolatePackage(
      root,
      name,
      versions[name],
      "node_modules/.bun/node_modules",
    );
    const result = await checkLocalPiBaseline(root);
    expect(result.issues).toEqual([`installed-tree: ${name} is not installed`]);
  });

  test("rejects a dangling exposed package even with a valid isolated fallback", async () => {
    const root = await setupBaseline();
    const schema = "@earendil-works/pi-schema";
    await isolatePackage(
      root,
      schema,
      versions[schema],
      "node_modules/.bun/node_modules",
    );
    await symlink(
      join(root, "missing-schema"),
      join(root, "node_modules", schema),
      "dir",
    );
    const result = await checkLocalPiBaseline(root);
    expect(result.issues).toEqual([
      `installed-tree: ${schema} is not installed`,
    ]);
  });

  test("rejects the wrong package identity in a contained isolated root", async () => {
    const root = await setupBaseline();
    const schema = "@earendil-works/pi-schema";
    const installed = await isolatePackage(root, schema, versions[schema]);
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "schema-copy", version: versions[schema] }),
    );
    const result = await checkLocalPiBaseline(root);
    expect(result.issues).toEqual([
      `installed-tree: ${schema} is not installed`,
    ]);
  });

  test("rejects an isolated package whose version differs from the lock", async () => {
    const root = await setupBaseline();
    const schema = "@earendil-works/pi-schema";
    const installed = await isolatePackage(root, schema, versions[schema]);
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: schema, version: "1.6.1" }),
    );
    const result = await checkLocalPiBaseline(root);
    expect(result.issues).toEqual([
      `installed-tree: ${schema} installed=1.6.1 locked=${versions[schema]}`,
    ]);
  });

  test("rejects an external package manifest symlink in an isolated root", async () => {
    const root = await setupBaseline();
    const schema = "@earendil-works/pi-schema";
    const installed = await isolatePackage(root, schema, versions[schema]);
    const manifest = join(installed, "package.json");
    const outside = join(root, "schema.json");
    await rename(manifest, outside);
    await symlink(outside, manifest);
    const result = await checkLocalPiBaseline(root);
    expect(result.issues).toEqual([
      `installed-tree: ${schema} is not installed`,
    ]);
  });

  test("rejects a missing or redirected transitive pi-schema tree", async () => {
    const root = await setupBaseline();
    const schema = join(root, "node_modules/@earendil-works/pi-schema");
    const outside = join(root, "other-schema");
    await rename(schema, outside);
    const missing = await checkLocalPiBaseline(root);
    expect(missing.issues).toContain(
      "installed-tree: @earendil-works/pi-schema is not installed",
    );

    await symlink(outside, schema, "dir");
    const redirected = await checkLocalPiBaseline(root);
    expect(redirected.issues).toEqual(missing.issues);
  });

  test("reports direct pin, lock, and stale installed tree separately", async () => {
    const root = await setupBaseline();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@earendil-works/pi-coding-agent": "2.0.0",
          "@earendil-works/pi-ai": "1.6.0",
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
      "@earendil-works/pi-coding-agent": "^1.6.0",
      "@earendil-works/pi-ai": "1.6.0",
      "@earendil-works/pi-tui": "1.6.0",
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
          Object.entries(resolved).map(([name, version]) => [
            name,
            [`${name}@${version}`],
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
