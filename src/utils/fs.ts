import { existsSync, lstatSync, type Dirent } from "fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
} from "fs/promises";
import { dirname, join } from "path";
import { expandPath } from "./paths.js";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(expandPath(path));
    return true;
  } catch {
    return false;
  }
};

const fileExistsSync = (path: string): boolean => existsSync(expandPath(path));

const isSymlink = async (path: string): Promise<boolean> => {
  try {
    const stats = await lstat(expandPath(path));
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
};

const isSymlinkSync = (path: string): boolean => {
  try {
    return lstatSync(expandPath(path)).isSymbolicLink();
  } catch {
    return false;
  }
};

const ensureDir = async (path: string): Promise<void> => {
  const expanded = expandPath(path);
  await mkdir(expanded, { recursive: true });
};

const createSymlink = async (source: string, target: string): Promise<void> => {
  const expandedSource = expandPath(source);
  const expandedTarget = expandPath(target);

  await ensureDir(dirname(expandedTarget));
  await symlink(expandedSource, expandedTarget);
};

const removeSymlink = async (path: string): Promise<void> => {
  const expanded = expandPath(path);
  await unlink(expanded);
};

const copyRecursive = async (source: string, dest: string): Promise<void> => {
  const expandedSource = expandPath(source);
  const expandedDest = expandPath(dest);

  const stats = await stat(expandedSource);

  if (stats.isDirectory()) {
    await ensureDir(expandedDest);
    const files = await readdir(expandedSource);

    for (const file of files) {
      await copyRecursive(join(expandedSource, file), join(expandedDest, file));
    }
  } else {
    await ensureDir(dirname(expandedDest));
    await copyFile(expandedSource, expandedDest);
  }
};

const removeRecursive = async (path: string): Promise<void> => {
  const expanded = expandPath(path);
  await rm(expanded, { force: true, recursive: true });
};

const readDir = async (path: string): Promise<Dirent[]> => {
  const expanded = expandPath(path);
  return await readdir(expanded, { withFileTypes: true });
};

export {
  fileExists,
  fileExistsSync,
  isSymlink,
  isSymlinkSync,
  ensureDir,
  createSymlink,
  removeSymlink,
  copyRecursive,
  removeRecursive,
  readDir,
};
