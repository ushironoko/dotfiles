import { join } from "path";
import type { FileMapping, SymlinkOptions } from "../types/config.js";
import type { Logger } from "../utils/logger.js";
import { expandPath } from "../utils/paths.js";
import { createSymlink, removeSymlink } from "./symlink-operations.js";
import { applyFilePermission, applyPermissions } from "./permission-manager.js";
import { checkSymlinkStatus } from "./symlink-status.js";

// SymlinkManagerを作成
export const createSymlinkManager = (logger: Logger) => {
  const createSelectiveSymlinks = async (
    mapping: FileMapping,
    options: SymlinkOptions,
  ): Promise<void> => {
    const items = mapping.include || mapping.files;
    if (!items) {
      throw new Error("Selective mapping requires 'include' or 'files' array");
    }

    const { dryRun = false, force = false } = options;

    logger.info(`Processing selective symlinks for ${mapping.target}`);
    logger.debug(`  Files to link: ${items.join(", ")}`);

    for (const item of items) {
      const sourcePath = join(mapping.source, item);
      const targetPath = join(mapping.target, item);

      // Apply permissions to source file before creating symlink
      if (
        mapping.permissions &&
        "object" === typeof mapping.permissions &&
        mapping.permissions[item]
      ) {
        await applyFilePermission(
          sourcePath,
          mapping.permissions[item],
          dryRun,
          logger,
        );
      }

      await createSymlink(sourcePath, targetPath, force, logger, dryRun);
    }
  };

  const createFromMapping = async (
    mapping: FileMapping,
    options: SymlinkOptions = {},
  ): Promise<void> => {
    const { dryRun = false, force = false } = options;

    if ("selective" === mapping.type) {
      await createSelectiveSymlinks(mapping, options);
    } else {
      await createSymlink(
        mapping.source,
        mapping.target,
        force,
        logger,
        dryRun,
      );

      if (mapping.permissions) {
        if ("string" === typeof mapping.permissions) {
          await applyFilePermission(
            mapping.target,
            mapping.permissions,
            dryRun,
            logger,
          );
        } else {
          await applyPermissions(mapping, dryRun, logger);
        }
      }
    }
  };

  const createMultipleSymlinks = async (
    mappings: FileMapping[],
    options: SymlinkOptions = {},
  ): Promise<void> => {
    for (const mapping of mappings) {
      await createFromMapping(mapping, options);
    }
  };

  const removeSymlinkWrapper = async (
    target: string,
    dryRun = false,
  ): Promise<void> => {
    await removeSymlink(target, logger, dryRun);
  };

  const removeFromMapping = async (
    mapping: FileMapping,
    dryRun = false,
  ): Promise<void> => {
    const expandedTarget = expandPath(mapping.target);

    if ("selective" === mapping.type && mapping.include) {
      // Remove selective symlinks
      for (const file of mapping.include) {
        const targetFile = join(expandedTarget, file);
        await removeSymlinkWrapper(targetFile, dryRun);
      }
    } else {
      // Remove regular symlink
      await removeSymlinkWrapper(expandedTarget, dryRun);
    }
  };

  const removeMultipleSymlinks = async (
    mappings: FileMapping[],
    dryRun = false,
  ): Promise<void> => {
    for (const mapping of mappings) {
      await removeFromMapping(mapping, dryRun);
    }
  };

  return {
    createSymlink: (
      source: string,
      target: string,
      force: boolean,
      dryRun = false,
    ) => createSymlink(source, target, force, logger, dryRun),
    createFromMapping,
    createMultipleSymlinks,
    checkSymlinkStatus,
    removeSymlink: removeSymlinkWrapper,
    removeFromMapping,
    removeMultipleSymlinks,
  };
};

export type SymlinkManager = ReturnType<typeof createSymlinkManager>;
