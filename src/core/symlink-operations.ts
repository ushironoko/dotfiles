import {
  fileExists,
  createSymlink as fsCreateSymlink,
  removeSymlink as fsRemoveSymlink,
  isSymlink,
  removeRecursive,
} from "../utils/fs.js";
import type { Logger } from "../utils/logger.js";
import { expandPath } from "../utils/paths.js";

export const createSymlink = async (
  source: string,
  target: string,
  force: boolean,
  logger: Logger,
  dryRun = false,
): Promise<void> => {
  const expandedSource = expandPath(source);
  const expandedTarget = expandPath(target);

  if (await fileExists(expandedTarget)) {
    if (await isSymlink(expandedTarget)) {
      if (force) {
        logger.action("Removing", `existing symlink: ${expandedTarget}`);
        if (!dryRun) {
          await fsRemoveSymlink(expandedTarget);
        }
      } else {
        logger.warn(`Symlink already exists: ${expandedTarget}`);
        return;
      }
    } else {
      if (force) {
        logger.action("Removing", `existing file/directory: ${expandedTarget}`);
        if (!dryRun) {
          await removeRecursive(expandedTarget);
        }
      } else {
        logger.warn(
          `Target already exists and is not a symlink: ${expandedTarget}`,
        );
        return;
      }
    }
  }

  logger.action("Creating symlink", `${expandedSource} -> ${expandedTarget}`);
  if (!dryRun) {
    await fsCreateSymlink(expandedSource, expandedTarget);
  }
};

export const removeSymlink = async (
  target: string,
  logger: Logger,
  dryRun = false,
): Promise<void> => {
  const expandedTarget = expandPath(target);

  if (await isSymlink(expandedTarget)) {
    logger.action("Removing", `symlink: ${expandedTarget}`);
    if (!dryRun) {
      await fsRemoveSymlink(expandedTarget);
    }
  } else if (await fileExists(expandedTarget)) {
    logger.warn(`Target is not a symlink: ${expandedTarget}`);
  } else {
    logger.warn(`Target does not exist: ${expandedTarget}`);
  }
};
