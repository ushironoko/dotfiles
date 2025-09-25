import { dirname, resolve } from "path";
import { homedir } from "os";

const expandPath = (path: string): string => {
  if (path.startsWith("~")) {
    // Use process.env.HOME if available (for testing), otherwise use homedir()
    const home = process.env.HOME || homedir();
    return path.replace(/^~/, home);
  }
  return resolve(path);
};

const getRelativePath = (fullPath: string, basePath: string): string => {
  const expanded = expandPath(fullPath);
  const base = expandPath(basePath);

  if (expanded.startsWith(base)) {
    const SEPARATOR_LENGTH = 1;
    return expanded.slice(base.length + SEPARATOR_LENGTH);
  }

  return expanded;
};

const ensureParentDir = (path: string): string => dirname(expandPath(path));

const getDotfilesDir = (): string => {
  const currentFileUrl = import.meta.url;
  const currentFilePath = currentFileUrl.replace("file://", "");
  return resolve(dirname(currentFilePath), "../..");
};

export { expandPath, getRelativePath, ensureParentDir, getDotfilesDir };
