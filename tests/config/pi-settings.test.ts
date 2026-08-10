import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import config from "../../dotfiles.config";
import settings from "../../pi/settings.json";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MANAGED_SKILL_EXCLUSION = "!/Users/ushironoko/.agents/skills/**";

describe("Pi settings management", () => {
  test("installs the complete tracked settings file as a child symlink", () => {
    expect(
      config.mappings.find(
        (mapping) => mapping.target === "~/.pi/agent/settings.json",
      ),
    ).toEqual({
      source: "./pi/settings.json",
      target: "~/.pi/agent/settings.json",
      type: "file",
    });
  });

  test("excludes the shared Agent Skills location", () => {
    expect(settings.skills).toContain(MANAGED_SKILL_EXCLUSION);
  });

  test("uses native fullscreen mode without an opaque scrollbar", () => {
    expect(settings.tuiMode).toBe("fullscreen");
    expect(settings.fullscreenScrollbar).toBe("hidden");
  });

  test("requires the Pi clean filter for the live settings file", async () => {
    const [attributes, setup] = await Promise.all([
      readFile(resolve(REPO_ROOT, ".gitattributes"), "utf8"),
      readFile(resolve(REPO_ROOT, "scripts/setup-git-filters.sh"), "utf8"),
    ]);

    expect(attributes).toContain("pi/settings.json filter=pi-scrub");
    expect(setup).toContain(
      'git config filter.pi-scrub.clean "bun pi/scrub-settings.ts"',
    );
    expect(setup).toContain("git config filter.pi-scrub.required true");
  });
});
