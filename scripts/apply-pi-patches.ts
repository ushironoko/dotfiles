import { resolve } from "node:path";
import { checkPiCompatibility } from "./pi-compat/index";
import { discoverPiInstallation } from "./pi-compat/installation";
import { applyPiPatches } from "./pi-compat/patches";
import {
  acquireUpdateLock,
  assertNoPendingUpdateRecovery,
  defaultUpdateJournalPath,
  defaultUpdateLockPath,
} from "./pi-compat/update-state";

const repoRoot = resolve(import.meta.dir, "..");

try {
  const lock = await acquireUpdateLock(defaultUpdateLockPath());
  try {
    await assertNoPendingUpdateRecovery(defaultUpdateJournalPath());
    const installation = await discoverPiInstallation();
    await checkPiCompatibility(repoRoot);
    const results = await applyPiPatches(installation, {
      repoRoot,
      verify: async () => {
        await checkPiCompatibility(repoRoot);
      },
    });
    console.log(
      `apply-pi-patches: OK (${results.map(({ packageName, version, status }) => `${packageName}@${version} ${status}`).join(", ")})`,
    );
  } finally {
    await lock.release();
  }
} catch (error) {
  console.error(`apply-pi-patches: FAILED: ${String(error)}`);
  process.exit(1);
}
