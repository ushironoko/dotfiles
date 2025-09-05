import { existsSync, lstatSync, Dirent } from "fs";
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
import { expandPath } from "./paths";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(expandPath(path));
    return true;
  } catch {
    return false;
  }
}

export function fileExistsSync(path: string): boolean {
  return existsSync(expandPath(path));
}

export async function isSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(expandPath(path));
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export function isSymlinkSync(path: string): boolean {
  try {
    return lstatSync(expandPath(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  const expanded = expandPath(path);
  await mkdir(expanded, { recursive: true });
}

export async function createSymlink(
  source: string,
  target: string,
): Promise<void> {
  const expandedSource = expandPath(source);
  const expandedTarget = expandPath(target);

  await ensureDir(dirname(expandedTarget));
  await symlink(expandedSource, expandedTarget);
}

export async function removeSymlink(path: string): Promise<void> {
  const expanded = expandPath(path);
  await unlink(expanded);
}

export async function copyRecursive(
  source: string,
  dest: string,
): Promise<void> {
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
}

export async function removeRecursive(path: string): Promise<void> {
  const expanded = expandPath(path);
  await rm(expanded, { force: true, recursive: true });
}

export async function readDir(path: string): Promise<Dirent[]> {
  const expanded = expandPath(path);
  return await readdir(expanded, { withFileTypes: true });
}
