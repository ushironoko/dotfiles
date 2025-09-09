import { chmod } from "fs/promises";
import { join } from "path";
import type { FileMapping } from "../types/config.js";
import type { Logger } from "../utils/logger.js";
import { expandPath } from "../utils/paths.js";

const applyFilePermission = async (
  filePath: string,
  permission: string,
  dryRun: boolean,
  logger: Logger,
): Promise<void> => {
  const expandedPath = expandPath(filePath);
  logger.action("Setting permissions", `${permission} on ${expandedPath}`);

  if (!dryRun) {
    const OCTAL_BASE = 8;
    await chmod(expandedPath, parseInt(permission, OCTAL_BASE));
  }
};

const applyPermissions = async (
  mapping: FileMapping,
  dryRun: boolean,
  logger: Logger,
): Promise<void> => {
  if (!mapping.permissions || typeof mapping.permissions === "string") {
    return;
  }

  for (const [file, permission] of Object.entries(mapping.permissions)) {
    const targetPath = join(mapping.target, file);
    await applyFilePermission(targetPath, permission, dryRun, logger);
  }
};

export { applyFilePermission, applyPermissions };
