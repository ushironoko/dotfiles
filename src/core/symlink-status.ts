import { lstat, readlink } from "fs/promises";
import { dirname, resolve } from "path";
import type { SymlinkStatus } from "../types/config.js";
import { fileExists } from "../utils/fs.js";
import { expandPath } from "../utils/paths.js";

export const checkSymlinkStatus = async (
  target: string,
  expectedSource?: string,
): Promise<SymlinkStatus> => {
  const expandedTarget = expandPath(target);

  // lstatを使用してシンボリックリンク自体の存在を確認
  try {
    const stats = await lstat(expandedTarget);

    if (!stats.isSymbolicLink()) {
      return { exists: true, isSymlink: false };
    }

    const actualTarget = await readlink(expandedTarget);
    const targetPath = resolve(dirname(expandedTarget), actualTarget);
    const targetExists = await fileExists(targetPath);

    if (!expectedSource) {
      return { exists: true, isSymlink: true, targetExists };
    }

    const expandedSource = resolve(
      dirname(expandedTarget),
      expandPath(expectedSource),
    );
    const pointsToCorrectTarget = targetPath === expandedSource;

    return {
      exists: true,
      isSymlink: true,
      pointsToCorrectTarget,
      targetExists,
    };
  } catch {
    return { exists: false, isSymlink: false };
  }
};
