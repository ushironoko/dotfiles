// ~/.claude/settings.json（実体は claude/.claude/settings.json）の env.ANTHROPIC_BASE_URL を
// 他キーを壊さず追加/削除する。純粋変換 + 薄いファイル I/O。
import { promises as fs } from "node:fs";

type Settings = Record<string, unknown>;

const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
const JSON_INDENT = 2;

const getEnv = (s: Settings): Record<string, unknown> => {
  const e = s["env"];
  return e && typeof e === "object" && !Array.isArray(e)
    ? { ...(e as Record<string, unknown>) }
    : {};
};

export const applyBaseUrlEnv = (settings: Settings, url: string): Settings => {
  const env = { ...getEnv(settings), [BASE_URL_KEY]: url };
  return { ...settings, env };
};

export const stripBaseUrlEnv = (settings: Settings): Settings => {
  const env = getEnv(settings);
  delete env[BASE_URL_KEY];
  const next: Settings = { ...settings };
  if (Object.keys(env).length === 0) delete next["env"];
  else next["env"] = env;
  return next;
};

const readSettings = async (path: string): Promise<Settings> => {
  const obj: unknown = JSON.parse(await fs.readFile(path, "utf8"));
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as Settings)
    : {};
};

const writeSettings = async (path: string, s: Settings): Promise<void> => {
  await fs.writeFile(path, `${JSON.stringify(s, null, JSON_INDENT)}\n`, "utf8");
};

export const setBaseUrlEnv = async (
  path: string,
  url: string,
): Promise<void> => {
  await writeSettings(path, applyBaseUrlEnv(await readSettings(path), url));
};

export const removeBaseUrlEnv = async (path: string): Promise<void> => {
  await writeSettings(path, stripBaseUrlEnv(await readSettings(path)));
};
