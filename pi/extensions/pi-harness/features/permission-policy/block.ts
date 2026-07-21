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
