import { describe, test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import config from "../../dotfiles.config";

const REPO_ROOT = resolve(import.meta.dir, "../..");

// Guards against "config directory was removed/renamed but the mapping in
// dotfiles.config.ts was not updated" (and vice versa) — dangling sources are
// otherwise only caught by a manual `install --dry-run`.
describe("dotfiles.config.ts mappings integrity", () => {
  test("every mapping source exists in the repository", async () => {
    const missing: string[] = [];
    for (const mapping of config.mappings ?? []) {
      try {
        await fs.access(resolve(REPO_ROOT, mapping.source));
      } catch {
        missing.push(mapping.source);
      }
    }
    expect(missing).toEqual([]);
  });

  test("selective mappings list files that exist in their source directory", async () => {
    const missing: string[] = [];
    for (const mapping of config.mappings ?? []) {
      if (mapping.type !== "selective") continue;
      for (const file of mapping.include ?? []) {
        try {
          await fs.access(resolve(REPO_ROOT, mapping.source, file));
        } catch {
          missing.push(`${mapping.source}/${file}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
