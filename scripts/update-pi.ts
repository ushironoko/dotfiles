import { resolve } from "node:path";
import { checkPiCompatibility } from "./pi-compat/index";
import { discoverPiInstallation } from "./pi-compat/installation";
import { updatePiSafely } from "./pi-compat/update-state";

const repoRoot = resolve(import.meta.dir, "..");

try {
  const result = await updatePiSafely({
    checkCompatibility: () => checkPiCompatibility(repoRoot),
    discover: () => discoverPiInstallation(),
  });
  const log = result.ok ? console.log : console.error;
  log(`update-pi: ${result.message}`);
  if (result.manualRecoveryArgv !== undefined) {
    console.error(
      "Recovery remains journaled. Rerun `bun run update:pi`; it executes the recorded exact cohort without a shell, restores the preflight package snapshot, and verifies the result.",
    );
  }
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`update-pi: FAILED before update: ${String(error)}`);
  process.exit(1);
}
