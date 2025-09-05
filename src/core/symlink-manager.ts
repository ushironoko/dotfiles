import { chmod, lstat, readlink } from "fs/promises";
import { join, resolve, dirname } from "path";
import { FileMapping, SymlinkOptions, SymlinkStatus } from "../types/config";
import { 
  fileExists,
  createSymlink as fsCreateSymlink,
  removeSymlink as fsRemoveSymlink,
  isSymlink,
  removeRecursive
} from "../utils/fs";
import { Logger } from "../utils/logger";
import { expandPath } from "../utils/paths";

// ファクトリー関数：SymlinkManagerを作成
export const createSymlinkManager = (logger: Logger) => {
  
  const createSymlink = async (
    source: string, 
    target: string, 
    force: boolean,
    dryRun = false
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
          logger.warn(`Target already exists and is not a symlink: ${expandedTarget}`);
          return;
        }
      }
    }

    logger.action("Creating symlink", `${expandedSource} -> ${expandedTarget}`);
    if (!dryRun) {
      await fsCreateSymlink(expandedSource, expandedTarget);
    }
  };

  const applyFilePermission = async (
    filePath: string,
    permission: string,
    dryRun: boolean
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
    dryRun: boolean
  ): Promise<void> => {
    if (!mapping.permissions || "string" === typeof mapping.permissions) {
      return;
    }

    for (const [file, permission] of Object.entries(mapping.permissions)) {
      const targetPath = join(mapping.target, file);
      await applyFilePermission(targetPath, permission, dryRun);
    }
  };

  const createSelectiveSymlinks = async (
    mapping: FileMapping,
    options: SymlinkOptions
  ): Promise<void> => {
    const items = mapping.include || mapping.files;
    if (!items) {
      throw new Error("Selective mapping requires 'include' or 'files' array");
    }

    const { dryRun = false, force = false } = options;

    for (const item of items) {
      const sourcePath = join(mapping.source, item);
      const targetPath = join(mapping.target, item);
      
      await createSymlink(sourcePath, targetPath, force, dryRun);
      
      if (mapping.permissions && "object" === typeof mapping.permissions && mapping.permissions[item]) {
        await applyFilePermission(
          targetPath, 
          mapping.permissions[item], 
          dryRun
        );
      }
    }
  };

  const createFromMapping = async (
    mapping: FileMapping, 
    options: SymlinkOptions = {}
  ): Promise<void> => {
    const { dryRun = false, force = false } = options;

    if ("selective" === mapping.type) {
      await createSelectiveSymlinks(mapping, options);
    } else {
      await createSymlink(mapping.source, mapping.target, force, dryRun);
      
      if (mapping.permissions) {
        if ("string" === typeof mapping.permissions) {
          await applyFilePermission(mapping.target, mapping.permissions, dryRun);
        } else {
          await applyPermissions(mapping, dryRun);
        }
      }
    }
  };

  const createMultipleSymlinks = async (
    mappings: FileMapping[],
    options: SymlinkOptions = {}
  ): Promise<void> => {
    for (const mapping of mappings) {
      await createFromMapping(mapping, options);
    }
  };

  const checkSymlinkStatus = async (
    target: string, 
    expectedSource?: string
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

      const expandedSource = resolve(dirname(expandedTarget), expandPath(expectedSource));
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

  return {
    createSymlink,
    createFromMapping,
    createMultipleSymlinks,
    checkSymlinkStatus,
  };
};

export type SymlinkManager = ReturnType<typeof createSymlinkManager>;