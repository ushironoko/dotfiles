import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  applyBaseUrlEnv,
  stripBaseUrlEnv,
  setBaseUrlEnv,
  removeBaseUrlEnv,
} from "../../../src/core/logproxy/settings-env";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const URL_ = "http://127.0.0.1:8787";

describe("applyBaseUrlEnv / stripBaseUrlEnv（純粋）", () => {
  it("env が無い settings に追加し permissions は保持", () => {
    const before = { permissions: { allow: ["x"] }, model: "opus" };
    const after = applyBaseUrlEnv(before, URL_);
    expect(after.env).toEqual({ ANTHROPIC_BASE_URL: URL_ });
    expect(after.permissions).toEqual({ allow: ["x"] });
    expect(after.model).toBe("opus");
  });

  it("既存 env の他キーを保持して追加", () => {
    const after = applyBaseUrlEnv({ env: { FOO: "1" } }, URL_);
    expect(after.env).toEqual({ FOO: "1", ANTHROPIC_BASE_URL: URL_ });
  });

  it("冪等（2回適用しても同じ）", () => {
    const once = applyBaseUrlEnv({ permissions: {} }, URL_);
    const twice = applyBaseUrlEnv(once, URL_);
    expect(twice).toEqual(once);
  });

  it("strip は ANTHROPIC_BASE_URL だけ消し他 env キーは残す", () => {
    const after = stripBaseUrlEnv({
      env: { FOO: "1", ANTHROPIC_BASE_URL: URL_ },
    });
    expect(after.env).toEqual({ FOO: "1" });
  });

  it("strip で env が空になれば env ごと消す", () => {
    const after = stripBaseUrlEnv({
      permissions: {},
      env: { ANTHROPIC_BASE_URL: URL_ },
    });
    expect("env" in after).toBe(false);
    expect(after.permissions).toEqual({});
  });

  it("apply→strip で元に戻る（env 無しに）", () => {
    const original = { permissions: { allow: ["a"] } };
    expect(stripBaseUrlEnv(applyBaseUrlEnv(original, URL_))).toEqual(original);
  });
});

describe("setBaseUrlEnv / removeBaseUrlEnv（ファイル I/O）", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await setupTestDirectory("logproxy-settings");
    path = join(dir, "settings.json");
  });
  afterEach(async () => {
    await cleanupTestDirectory(dir);
  });

  it("他キーを保持して env を書き込み、2スペース整形で往復できる", async () => {
    const original = {
      permissions: { allow: ["Bash(bun:*)"] },
      model: "opus[1m]",
    };
    await fs.writeFile(path, JSON.stringify(original, null, 2));

    await setBaseUrlEnv(path, URL_);
    const afterSet = JSON.parse(await fs.readFile(path, "utf8"));
    expect(afterSet.env.ANTHROPIC_BASE_URL).toBe(URL_);
    expect(afterSet.permissions).toEqual({ allow: ["Bash(bun:*)"] });
    expect(await fs.readFile(path, "utf8")).toContain('\n  "');

    await removeBaseUrlEnv(path);
    const afterRemove = JSON.parse(await fs.readFile(path, "utf8"));
    expect(afterRemove).toEqual(original);
  });
});
