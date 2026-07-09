// logproxy コマンド: Claude Code の文脈を記録するローカル逆プロキシの操作。
//   start     - プロキシを前景起動（launchd がこれを起動する / 手動検証にも使う）
//   status    - 稼働状況・env 設定・ログ状況の確認
//   tail      - 直近セッションのレコードを追尾表示
//   prune     - 保存管理スイープ（idle gzip + 期限切れ削除）を1回実行
//   show      - 指定ターンの文脈全文（system/tools/messages）を整形表示
//   install   - launchd 常駐化 + health 確認後に settings.json の env を有効化
//   uninstall - env を外して直結復帰 → agent 停止・plist 削除
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { define } from "../utils/command-helpers.js";
import { createLogger } from "../utils/logger.js";
import { expandPath, getDotfilesDir } from "../utils/paths.js";
import { createLogWriter } from "../core/logproxy/log-writer.js";
import { createProxyServer } from "../core/logproxy/proxy.js";
import { runSweep } from "../core/logproxy/sweep.js";
import {
  bootout,
  bootstrap,
  type PlistParams,
  portInUse,
  removePlistFile,
  renderPlist,
  resolveBunPath,
  writePlistFile,
} from "../core/logproxy/launchd.js";
import {
  removeBaseUrlEnv,
  setBaseUrlEnv,
} from "../core/logproxy/settings-env.js";
import { runInstall, runUninstall } from "../core/logproxy/install.js";
import {
  type RenderFormat,
  renderContext,
  selectRequestTurn,
} from "../core/logproxy/render.js";
import {
  DEFAULT_GZIP_IDLE_MINUTES,
  DEFAULT_HOST,
  DEFAULT_KEEP_DAYS,
  DEFAULT_LOG_DIR,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM,
  HEALTH_PATH,
  LAUNCHD_LABEL,
  type LogRecord,
  type RequestRecord,
  type ResponseRecord,
} from "../core/logproxy/types.js";

const SWEEP_INTERVAL_MS = 3_600_000; // 毎時
const TAIL_POLL_MS = 500;
const HEALTH_POLL_ATTEMPTS = 20;
const HEALTH_POLL_DELAY_MS = 250;
const SETTINGS_PATH = "~/.claude/settings.json";
const KNOWN_SUBCOMMANDS = new Set([
  "start",
  "status",
  "tail",
  "prune",
  "show",
  "install",
  "uninstall",
]);

const VALID_FORMATS = new Set<RenderFormat>(["text", "json", "md"]);

type Logger = ReturnType<typeof createLogger>;

interface CommonOpts {
  host: string;
  port: number;
  upstream: string;
  logDir: string;
  keepDays: number;
  gzipIdleMinutes: number;
}

const settingsPath = (): string => expandPath(SETTINGS_PATH);

/** health が 200 を返すまでポーリング。上がらなければ false。 */
const pollHealth = async (host: string, port: number): Promise<boolean> => {
  for (let i = 0; i < HEALTH_POLL_ATTEMPTS; i++) {
    try {
      const res = await fetch(`http://${host}:${port}${HEALTH_PATH}`);
      if (res.ok) return true;
    } catch {
      // まだ起動していない
    }
    await Bun.sleep(HEALTH_POLL_DELAY_MS);
  }
  return false;
};

const runInstallCmd = async (o: CommonOpts, logger: Logger): Promise<void> => {
  if (await portInUse(o.port, o.host)) {
    logger.error(`port ${o.port} is already in use; aborting install`);
    return;
  }
  const bunPath = await resolveBunPath();
  const repoRoot = getDotfilesDir();
  const home = homedir();
  const params: PlistParams = {
    label: LAUNCHD_LABEL,
    bunPath,
    entryPath: join(repoRoot, "bin", "dotfiles"),
    port: o.port,
    host: o.host,
    logDir: o.logDir,
    workingDir: repoRoot,
    home,
    path: `${home}/.local/bin:${home}/.local/share/mise/shims:/usr/bin:/bin:/usr/sbin:/sbin`,
    keepDays: o.keepDays,
    gzipIdleMinutes: o.gzipIdleMinutes,
  };
  const url = `http://${o.host}:${o.port}`;
  const result = await runInstall({
    writePlist: async () => {
      await fs.mkdir(o.logDir, { recursive: true });
      return writePlistFile(LAUNCHD_LABEL, renderPlist(params));
    },
    bootstrap: (p) => bootstrap(p),
    pollHealth: () => pollHealth(o.host, o.port),
    writeEnv: () => setBaseUrlEnv(settingsPath(), url),
    rollback: async () => {
      await bootout(LAUNCHD_LABEL);
      await removePlistFile(LAUNCHD_LABEL);
    },
    log: (m) => logger.info(m),
  });
  if (result.ok) {
    logger.success(`logproxy installed & enabled at ${url}`);
    logger.info("all Claude Code sessions now route through the proxy");
  } else {
    logger.error(`install aborted: ${result.reason} (settings.json untouched)`);
  }
};

const runUninstallCmd = async (logger: Logger): Promise<void> => {
  await runUninstall({
    removeEnv: () => removeBaseUrlEnv(settingsPath()),
    bootout: () => bootout(LAUNCHD_LABEL),
    removePlist: () => removePlistFile(LAUNCHD_LABEL),
  });
  logger.success("logproxy uninstalled (env removed, agent stopped)");
};

const summarize = (rec: LogRecord): string => {
  if (rec.kind === "request") {
    const r = rec as RequestRecord;
    return `→ req  ${r.endpoint}  model=${r.model ?? "?"}  tools=${r.stats.num_tools} msgs=${r.stats.num_messages} sys=${r.stats.system_chars}c  session=${r.session_id}`;
  }
  const r = rec as ResponseRecord;
  const u = r.usage;
  const tok = u
    ? `in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} cacheR=${u.cache_read_input_tokens ?? 0}`
    : "usage=?";
  return `← res  status=${r.status}  ${tok}  stop=${r.stop_reason ?? "?"}${r.aborted ? " (aborted)" : ""}`;
};

const runStart = async (o: CommonOpts, logger: Logger): Promise<void> => {
  const writer = createLogWriter({ baseDir: o.logDir });
  const proxy = createProxyServer({
    port: o.port,
    host: o.host,
    upstream: o.upstream,
    writer,
  });
  logger.success(
    `logproxy listening on http://${o.host}:${proxy.port} → ${o.upstream}`,
  );
  logger.info(`logs: ${o.logDir}`);

  const timer = setInterval(() => {
    void runSweep({
      dir: o.logDir,
      now: Date.now(),
      keepDays: o.keepDays,
      gzipIdleMinutes: o.gzipIdleMinutes,
      activeSessions: writer.pendingSessions(),
    });
  }, SWEEP_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await proxy.stop();
    await writer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Bun.serve がプロセスを生かし続ける。run() を返さないよう永続 await。
  await new Promise<never>(() => {});
};

const runStatus = async (o: CommonOpts, logger: Logger): Promise<void> => {
  let up = false;
  try {
    const res = await fetch(`http://${o.host}:${o.port}${HEALTH_PATH}`);
    up = res.ok;
  } catch {
    up = false;
  }
  logger.info(`proxy: ${up ? "UP" : "DOWN"} (http://${o.host}:${o.port})`);

  let envSet = false;
  try {
    const s = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as {
      env?: { ANTHROPIC_BASE_URL?: string };
    };
    envSet = Boolean(s.env?.ANTHROPIC_BASE_URL);
  } catch {
    envSet = false;
  }
  logger.info(
    `settings.json ANTHROPIC_BASE_URL: ${envSet ? "set" : "not set"}`,
  );

  try {
    const files = (await fs.readdir(o.logDir)).filter((f) =>
      f.endsWith(".jsonl"),
    );
    logger.info(`logs: ${o.logDir} (${files.length} active session file(s))`);
  } catch {
    logger.info(`logs: ${o.logDir} (none yet)`);
  }
};

const runPrune = async (o: CommonOpts, logger: Logger): Promise<void> => {
  const res = await runSweep({
    dir: o.logDir,
    now: Date.now(),
    keepDays: o.keepDays,
    gzipIdleMinutes: o.gzipIdleMinutes,
  });
  logger.success(`pruned: gzipped ${res.gzipped}, deleted ${res.deleted}`);
};

const newestSessionFile = async (
  logDir: string,
  session?: string,
): Promise<string | undefined> => {
  let entries: string[];
  try {
    entries = (await fs.readdir(logDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  if (session) {
    const target = `${session}.jsonl`;
    return entries.includes(target) ? target : undefined;
  }
  let newest: { name: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    const st = await fs.stat(join(logDir, name));
    if (!newest || st.mtimeMs > newest.mtimeMs)
      newest = { name, mtimeMs: st.mtimeMs };
  }
  return newest?.name;
};

const runTail = async (
  o: CommonOpts,
  logger: Logger,
  session: string | undefined,
): Promise<void> => {
  const file = await newestSessionFile(o.logDir, session);
  if (!file) {
    logger.warn(`no active session log found in ${o.logDir}`);
    return;
  }
  const path = join(o.logDir, file);
  logger.info(`tailing ${path}`);
  let offset = 0;
  let residual = "";
  const emit = (line: string): void => {
    if (!line.trim()) return;
    try {
      console.log(summarize(JSON.parse(line) as LogRecord));
    } catch {
      // 不完全な行は無視
    }
  };
  // 既存分 + 追尾。Ctrl-C で終了。
  for (;;) {
    try {
      const buf = await fs.readFile(path);
      if (buf.byteLength > offset) {
        residual += buf.subarray(offset).toString("utf8");
        offset = buf.byteLength;
        const parts = residual.split("\n");
        residual = parts.pop() ?? "";
        for (const p of parts) emit(p);
      }
    } catch {
      // ファイルが gzip 化された等。終了。
      logger.info("log file rotated or removed; stopping tail");
      return;
    }
    await Bun.sleep(TAIL_POLL_MS);
  }
};

const runShow = async (
  o: CommonOpts,
  logger: Logger,
  session: string | undefined,
  turn: number | undefined,
  format: RenderFormat,
): Promise<void> => {
  const file = await newestSessionFile(o.logDir, session);
  if (!file) {
    logger.warn(`no session log found in ${o.logDir}`);
    return;
  }
  let records: LogRecord[];
  try {
    records = (await fs.readFile(join(o.logDir, file), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogRecord);
  } catch {
    logger.error(`failed to read ${file}`);
    return;
  }
  const requests = records.filter(
    (r): r is RequestRecord => r.kind === "request",
  );
  const req = selectRequestTurn(requests, turn);
  if (!req) {
    logger.error(`turn out of range (1..${requests.length})`);
    return;
  }
  const res = records.find(
    (r): r is ResponseRecord =>
      r.kind === "response" && r.record_id === req.record_id,
  );
  // レンダリング結果は本文なので logger ではなく素の stdout へ
  console.log(renderContext(req, res, format));
};

export const logproxyCommand = define({
  name: "logproxy",
  description:
    "Capture Claude Code context-window payloads via a local reverse proxy",
  args: {
    port: {
      default: DEFAULT_PORT,
      description: `Proxy port (default: ${DEFAULT_PORT})`,
      short: "p",
      type: "number",
    },
    host: {
      default: DEFAULT_HOST,
      description: "Bind host (loopback only)",
      type: "string",
    },
    upstream: {
      default: DEFAULT_UPSTREAM,
      description: "Upstream Anthropic API base URL",
      type: "string",
    },
    dir: {
      default: DEFAULT_LOG_DIR,
      description: "Log directory",
      type: "string",
    },
    keepDays: {
      default: DEFAULT_KEEP_DAYS,
      description: "Delete logs older than N days",
      type: "number",
    },
    gzipIdleMinutes: {
      default: DEFAULT_GZIP_IDLE_MINUTES,
      description: "Gzip a session after N idle minutes",
      type: "number",
    },
    session: {
      description: "Target session id (for tail/show)",
      short: "s",
      type: "string",
    },
    turn: {
      description: "Turn to show (1-based; default: latest)",
      short: "t",
      type: "number",
    },
    format: {
      default: "text",
      description: "show format: text | json | md",
      short: "f",
      type: "string",
    },
    verbose: {
      default: false,
      description: "Verbose output",
      short: "v",
      type: "boolean",
    },
  },
  run: async (ctx) => {
    const logger = createLogger(ctx.values.verbose);
    const candidates = ctx.positionals.filter((p) => p !== "logproxy");
    const sub = candidates[0] ?? "status";
    if (!KNOWN_SUBCOMMANDS.has(sub)) {
      logger.error(`unknown subcommand: ${sub}`);
      logger.info(
        "subcommands: start | status | tail | prune | show | install | uninstall",
      );
      return;
    }
    const o: CommonOpts = {
      host: ctx.values.host,
      port: ctx.values.port,
      upstream: ctx.values.upstream,
      logDir: expandPath(ctx.values.dir),
      keepDays: ctx.values.keepDays,
      gzipIdleMinutes: ctx.values.gzipIdleMinutes,
    };
    switch (sub) {
      case "start":
        await runStart(o, logger);
        break;
      case "status":
        await runStatus(o, logger);
        break;
      case "tail":
        await runTail(o, logger, ctx.values.session);
        break;
      case "prune":
        await runPrune(o, logger);
        break;
      case "show": {
        const fmt = ctx.values.format as RenderFormat;
        const format = VALID_FORMATS.has(fmt) ? fmt : "text";
        await runShow(o, logger, ctx.values.session, ctx.values.turn, format);
        break;
      }
      case "install":
        await runInstallCmd(o, logger);
        break;
      case "uninstall":
        await runUninstallCmd(logger);
        break;
    }
  },
});
