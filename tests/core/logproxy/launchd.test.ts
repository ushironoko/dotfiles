import { describe, it, expect } from "bun:test";
import { renderPlist } from "../../../src/core/logproxy/launchd";

const params = {
  label: "com.ushironoko.claude-logproxy",
  bunPath: "/Users/u/.local/share/mise/installs/bun/1.3.13/bin/bun",
  entryPath: "/Users/u/ghq/dotfiles/bin/dotfiles",
  port: 8787,
  host: "127.0.0.1",
  logDir: "/Users/u/.claude/context-logs",
  workingDir: "/Users/u/ghq/dotfiles",
  home: "/Users/u",
  path: "/Users/u/.local/bin:/usr/bin:/bin",
  keepDays: 14,
  gzipIdleMinutes: 30,
};

describe("renderPlist", () => {
  const xml = renderPlist(params);

  it("Label と ProgramArguments に bun 実体パス・start を含む", () => {
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain(params.label);
    expect(xml).toContain(params.bunPath);
    expect(xml).toContain(params.entryPath);
    expect(xml).toContain("logproxy");
    expect(xml).toContain("start");
    expect(xml).toContain("8787");
  });

  it("RunAtLoad / KeepAlive / ThrottleInterval を持つ", () => {
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>ThrottleInterval</key>");
  });

  it("StandardOut/ErrPath を logDir 配下に持つ", () => {
    expect(xml).toContain(`${params.logDir}/daemon.out.log`);
    expect(xml).toContain(`${params.logDir}/daemon.err.log`);
  });

  it("EnvironmentVariables に PATH/HOME を持ち ANTHROPIC_BASE_URL は含まない", () => {
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<key>HOME</key>");
    expect(xml).not.toContain("ANTHROPIC_BASE_URL");
  });

  it("妥当な plist XML（doctype と plist 要素）", () => {
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist");
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
  });
});
