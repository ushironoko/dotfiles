// launchd LaunchAgent の生成と操作。
// renderPlist は純粋（テスト対象）。bootstrap/bootout 等は launchctl を叩く副作用ヘルパ。
import { promises as fs } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const THROTTLE_SECONDS = 10;
const PLIST_MODE = 0o644;
const PORT_CHECK_TIMEOUT_MS = 400;

export interface PlistParams {
  label: string;
  bunPath: string;
  entryPath: string;
  port: number;
  host: string;
  logDir: string;
  workingDir: string;
  home: string;
  path: string;
  keepDays: number;
  gzipIdleMinutes: number;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const stringEl = (v: string): string =>
  `      <string>${xmlEscape(v)}</string>`;

export const renderPlist = (p: PlistParams): string => {
  const args = [
    p.bunPath,
    p.entryPath,
    "logproxy",
    "start",
    "--port",
    String(p.port),
    "--host",
    p.host,
    "--dir",
    p.logDir,
    "--keepDays",
    String(p.keepDays),
    "--gzipIdleMinutes",
    String(p.gzipIdleMinutes),
  ];
  const argsXml = args.map(stringEl).join("\n");
  const out = xmlEscape(p.logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(p.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_SECONDS}</integer>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(p.workingDir)}</string>
    <key>StandardOutPath</key>
    <string>${out}/daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>${out}/daemon.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(p.path)}</string>
      <key>HOME</key>
      <string>${xmlEscape(p.home)}</string>
    </dict>
  </dict>
</plist>
`;
};

export const plistPath = (label: string): string =>
  join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

const guiTarget = (): string => `gui/${process.getuid?.() ?? 0}`;

/** mise 経由で bun の実体パスを解決（launchd の最小環境で PATH 非依存にするため）。 */
export const resolveBunPath = async (): Promise<string> => {
  const p = (await Bun.$`mise which bun`.text()).trim();
  if (!p) throw new Error("could not resolve bun path via `mise which bun`");
  return p;
};

export const writePlistFile = async (
  label: string,
  xml: string,
): Promise<string> => {
  const path = plistPath(label);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, xml, { mode: PLIST_MODE });
  return path;
};

export const bootstrap = async (path: string): Promise<void> => {
  await Bun.$`launchctl bootstrap ${guiTarget()} ${path}`.quiet();
};

export const bootout = async (label: string): Promise<void> => {
  await Bun.$`launchctl bootout ${guiTarget()}/${label}`.nothrow().quiet();
};

export const kickstart = async (label: string): Promise<void> => {
  await Bun.$`launchctl kickstart -k ${guiTarget()}/${label}`.nothrow().quiet();
};

export const isLoaded = async (label: string): Promise<boolean> => {
  const res = await Bun.$`launchctl print ${guiTarget()}/${label}`
    .nothrow()
    .quiet();
  return res.exitCode === 0;
};

export const removePlistFile = async (label: string): Promise<void> => {
  await fs.rm(plistPath(label), { force: true });
};

/** 指定ポートに TCP 接続を試み、既に誰かが listen していれば true。 */
export const portInUse = (port: number, host = "127.0.0.1"): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(PORT_CHECK_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
