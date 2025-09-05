import { chmod, lstat, readlink } from "fs/promises";
import { join, resolve, dirname } from "path";
import { FileMapping, SymlinkOptions, SymlinkStatus } from "@/types/config";
import { 
  fileExists,
  createSymlink as fsCreateSymlink,
  removeSymlink as fsRemoveSymlink,
  isSymlink,
  removeRecursive
} from "@/utils/fs";
import { Logger } from "@/utils/logger";
import { expandPath } from "@/utils/paths";

export class SymlinkManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async createSymlink(
    source: string, 
    target: string, 
    force: boolean,
    dryRun = false
  ): Promise<void> {
    const expandedSource = expandPath(source);
    const expandedTarget = expandPath(target);

    if (await fileExists(expandedTarget)) {
      if (await isSymlink(expandedTarget)) {
        if (force) {
          this.logger.action("Removing", `existing symlink: ${expandedTarget}`);
          if (!dryRun) {
            await fsRemoveSymlink(expandedTarget);
          }
        } else {
          this.logger.warn(`Symlink already exists: ${expandedTarget}`);
          return;
        }
      } else {
        if (force) {
          this.logger.action("Removing", `existing file/directory: ${expandedTarget}`);
          if (!dryRun) {
            await removeRecursive(expandedTarget);
          }
        } else {
          this.logger.warn(`Target already exists and is not a symlink: ${expandedTarget}`);
          return;
        }
      }
    }

    this.logger.action("Creating symlink", `${expandedSource} -> ${expandedTarget}`);
    if (!dryRun) {
      await fsCreateSymlink(expandedSource, expandedTarget);
    }
  }

  async createFromMapping(
    mapping: FileMapping, 
    options: SymlinkOptions = {}
  ): Promise<void> {
    const { dryRun = false, force = false } = options;

    if ("selective" === mapping.type) {
      await this.createSelectiveSymlinks(mapping, options);
    } else {
      await this.createSymlink(mapping.source, mapping.target, force, dryRun);
      
      if (mapping.permissions) {
        if ("string" === typeof mapping.permissions) {
          await this.applyFilePermission(mapping.target, mapping.permissions, dryRun);
        } else {
          await this.applyPermissions(mapping, dryRun);
        }
      }
    }
  }

  private async createSelectiveSymlinks(
    mapping: FileMapping,
    options: SymlinkOptions
  ): Promise<void> {
    const items = mapping.include || mapping.files;
    if (!items) {
      throw new Error("Selective mapping requires 'include' or 'files' array");
    }

    const { dryRun = false, force = false } = options;

    for (const item of items) {
      const sourcePath = join(mapping.source, item);
      const targetPath = join(mapping.target, item);
      
      await this.createSymlink(sourcePath, targetPath, force, dryRun);
      
      if (mapping.permissions && "object" === typeof mapping.permissions && mapping.permissions[item]) {
        await this.applyFilePermission(
          targetPath, 
          mapping.permissions[item], 
          dryRun
        );
      }
    }
  }

  private async applyPermissions(
    mapping: FileMapping,
    dryRun: boolean
  ): Promise<void> {
    if (!mapping.permissions) return;

    for (const [file, permission] of Object.entries(mapping.permissions)) {
      let targetPath: string;
      if ("selective" === mapping.type) {
        targetPath = join(mapping.target, file);
      } else {
        targetPath = mapping.target;
      }
      
      await this.applyFilePermission(targetPath, permission, dryRun);
    }
  }

  private async applyFilePermission(
    path: string,
    permission: string,
    dryRun: boolean
  ): Promise<void> {
    const expandedPath = expandPath(path);
    this.logger.action("Setting permissions", `${permission} on ${expandedPath}`);
    
    if (!dryRun) {
      const OCTAL_BASE = 8;
      const mode = parseInt(permission, OCTAL_BASE);
      await chmod(expandedPath, mode);
    }
  }

  async removeSymlink(path: string, dryRun = false): Promise<void> {
    const expandedPath = expandPath(path);

    if (!(await fileExists(expandedPath))) {
      this.logger.warn(`File not found: ${expandedPath}`);
      return;
    }

    if (!(await isSymlink(expandedPath))) {
      throw new Error(`Not a symlink: ${expandedPath}`);
    }

    this.logger.action("Removing symlink", expandedPath);
    if (!dryRun) {
      await fsRemoveSymlink(expandedPath);
    }
  }

  async createMultipleSymlinks(
    mappings: FileMapping[],
    dryRun = false
  ): Promise<void> {
    for (const mapping of mappings) {
      await this.createFromMapping(mapping, { dryRun, force: false });
    }
  }

  async checkSymlinkStatus(
    target: string, 
    expectedSource: string
  ): Promise<SymlinkStatus> {
    const expandedTarget = expandPath(target);
    const expandedSource = expandPath(expectedSource);
    
    // Check if the symlink itself exists (using lstat, not stat)
    let linkExists = false;
    let isLink = false;
    
    try {
      const stats = await lstat(expandedTarget);
      linkExists = true;
      isLink = stats.isSymbolicLink();
    } catch {
      // File doesn't exist at all
    }
    
    if (!linkExists) {
      return {
        exists: false,
        isSymlink: false,
      };
    }
    
    if (!isLink) {
      return {
        exists: true,
        isSymlink: false,
      };
    }

    let targetExists = false;
    let pointsToCorrectTarget = false;

    try {
      const linkTarget = await readlink(expandedTarget);
      
      // Convert relative path to absolute path
      const absoluteLinkTarget = resolve(dirname(expandedTarget), linkTarget);
      
      targetExists = await fileExists(absoluteLinkTarget);
      pointsToCorrectTarget = resolve(absoluteLinkTarget) === resolve(expandedSource);
    } catch {
      // If readlink fails, the symlink is broken
    }

    return {
      exists: true,
      isSymlink: true,
      targetExists,
      pointsToCorrectTarget,
    };
  }
}