import { writeSync } from "node:fs";

export const CHILD_PERMISSION_SIGNAL_ENV = "PI_HARNESS_PERMISSION_SIGNAL_TOKEN";

const CHILD_PERMISSION_SIGNAL_PREFIX = "[pi-harness:permission-blocked] ";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const formatChildPermissionSignal = (
  token: string | undefined,
): string | undefined =>
  token !== undefined && UUID_PATTERN.test(token)
    ? `${CHILD_PERMISSION_SIGNAL_PREFIX}${token}`
    : undefined;

export interface PermissionBlockResult {
  readonly block: true;
  readonly reason: string;
}

export interface PermissionBlockerOptions {
  readonly permissionSignalToken?: string;
  readonly writePermissionSignal?: (text: string) => void;
}

/**
 * Create the one permission-block path shared by policy and bridge handlers.
 * In a child, capture and consume the per-spawn authenticator during setup so
 * tools and grandchildren cannot inherit it. Every later block then emits the
 * same authenticated diagnostic frame without changing the tool-visible reason.
 */
export const createPermissionBlocker = (
  isChild: boolean,
  options: PermissionBlockerOptions = {},
): ((reason: string) => PermissionBlockResult) => {
  const permissionSignalToken = isChild
    ? (options.permissionSignalToken ??
      process.env[CHILD_PERMISSION_SIGNAL_ENV])
    : undefined;
  if (isChild && options.permissionSignalToken === undefined) {
    delete process.env[CHILD_PERMISSION_SIGNAL_ENV];
  }
  const writePermissionSignal =
    options.writePermissionSignal ?? ((text: string) => writeSync(2, text));

  return (reason: string): PermissionBlockResult => {
    if (isChild) {
      const signal = formatChildPermissionSignal(permissionSignalToken);
      if (signal !== undefined) {
        try {
          writePermissionSignal(`${signal}\n`);
        } catch {
          // A diagnostic side-channel failure must never unblock the command.
        }
      }
    }
    return { block: true, reason };
  };
};
