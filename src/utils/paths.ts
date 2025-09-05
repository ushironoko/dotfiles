import { dirname, resolve } from "path";
import { homedir } from "os";

export function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return path.replace(/^~/, homedir());
  }
  return resolve(path);
}

export function getRelativePath(fullPath: string, basePath: string): string {
  const expanded = expandPath(fullPath);
  const base = expandPath(basePath);

  if (expanded.startsWith(base)) {
    const SEPARATOR_LENGTH = 1;
    return expanded.slice(base.length + SEPARATOR_LENGTH);
  }

  return expanded;
}

export function ensureParentDir(path: string): string {
  return dirname(expandPath(path));
}

export function getDotfilesDir(): string {
  const currentFileUrl = import.meta.url;
  const currentFilePath = currentFileUrl.replace("file://", "");
  return resolve(dirname(currentFilePath), "../..");
}
