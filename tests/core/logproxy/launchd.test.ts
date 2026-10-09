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

  const specialXml = renderPlist({
    label: `com.example.&<>"'`,
    bunPath: `/tools/Bun & <runtime>/"bun"`,
    entryPath: `/repo/space dir/'entry' > main`,
    port: 9123,
    host: "127.0.0.1",
    logDir: `/logs/context & <archive> "quoted" 'single'`,
    workingDir: `/repo/work & <tree> "quoted"`,
    home: `/Users/home & <name> "quoted" 'single'`,
    path: `/tools/space dir & <bin>:"quoted":'single':/usr/bin`,
    keepDays: 17,
    gzipIdleMinutes: 43,
  });

  it("妥当な plist XML（doctype と plist 要素）", () => {
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist");
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
    expect(specialXml.startsWith("<?xml")).toBe(true);
    expect(specialXml).toContain("<!DOCTYPE plist");
    expect(specialXml.trimEnd().endsWith("</plist>")).toBe(true);
    expect(specialXml).toContain(
      `<string>com.example.&amp;&lt;&gt;"'</string>`,
    );
    expect(specialXml).toContain(
      `<string>/tools/Bun &amp; &lt;runtime&gt;/"bun"</string>`,
    );
    expect(specialXml).toContain(
      `<string>/repo/space dir/'entry' &gt; main</string>`,
    );
    expect(specialXml).toContain(
      `<string>/logs/context &amp; &lt;archive&gt; "quoted" 'single'/daemon.out.log</string>`,
    );
    expect(specialXml).toContain(
      `<string>/logs/context &amp; &lt;archive&gt; "quoted" 'single'/daemon.err.log</string>`,
    );
    expect(specialXml).toContain(
      `<string>/repo/work &amp; &lt;tree&gt; "quoted"</string>`,
    );
    expect(specialXml).toContain(
      `<string>/tools/space dir &amp; &lt;bin&gt;:"quoted":'single':/usr/bin</string>`,
    );
    expect(specialXml).toContain(
      `<string>/Users/home &amp; &lt;name&gt; "quoted" 'single'</string>`,
    );
    expect(specialXml).not.toContain("ANTHROPIC_BASE_URL");
  });

  it.skipIf(process.platform !== "darwin")(
    "Darwin plutil preserves the complete plist object",
    async () => {
      const parser = Bun.spawn(
        ["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", "-"],
        {
          stdin: new TextEncoder().encode(specialXml),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [decoded, errors, exitCode] = await Promise.all([
        new Response(parser.stdout).text(),
        new Response(parser.stderr).text(),
        parser.exited,
      ]);
      expect(errors).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(decoded)).toEqual({
        Label: `com.example.&<>"'`,
        ProgramArguments: [
          `/tools/Bun & <runtime>/"bun"`,
          `/repo/space dir/'entry' > main`,
          "logproxy",
          "start",
          "--port",
          "9123",
          "--host",
          "127.0.0.1",
          "--dir",
          `/logs/context & <archive> "quoted" 'single'`,
          "--keepDays",
          "17",
          "--gzipIdleMinutes",
          "43",
        ],
        RunAtLoad: true,
        KeepAlive: true,
        ThrottleInterval: 10,
        WorkingDirectory: `/repo/work & <tree> "quoted"`,
        StandardOutPath: `/logs/context & <archive> "quoted" 'single'/daemon.out.log`,
        StandardErrorPath: `/logs/context & <archive> "quoted" 'single'/daemon.err.log`,
        EnvironmentVariables: {
          PATH: `/tools/space dir & <bin>:"quoted":'single':/usr/bin`,
          HOME: `/Users/home & <name> "quoted" 'single'`,
        },
      });
    },
  );
});
