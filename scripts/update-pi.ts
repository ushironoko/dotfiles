import { resolve } from "node:path";
import { checkPiCompatibility } from "./pi-compat/index";
import { discoverPiInstallation } from "./pi-compat/installation";
import { applyPiPatches } from "./pi-compat/patches";
import {
  allowsUnsupportedPatchGeneration,
  updatePiSafely,
} from "./pi-compat/update-state";

const repoRoot = resolve(import.meta.dir, "..");

try {
  const result = await updatePiSafely({
    checkCompatibility: () => checkPiCompatibility(repoRoot),
    discover: () => discoverPiInstallation(),
    inspectPatches: async (installation) => {
      const results = await applyPiPatches(installation, {
        repoRoot,
        allowUnsupported: true,
        checkOnly: true,
      });
      return (
        results.length > 0 &&
        results.every(({ status }) => status === "already-applied")
      );
    },
    applyPatches: async (installation, phase) => {
      const results = await applyPiPatches(installation, {
        repoRoot,
        allowUnsupported: allowsUnsupportedPatchGeneration(phase),
      });
      return results.length > 0;
    },
  });
  const log = result.ok ? console.log : console.error;
  log(`update-pi: ${result.message}`);
  if (result.manualRecoveryArgv !== undefined) {
    console.error(
      "Recovery remains journaled. Rerun `bun run update:pi` when Bun's registry/cache is available; it executes the recorded exact cohort without a shell, reapplies required patches, and verifies the result.",
    );
  }
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`update-pi: FAILED before update: ${String(error)}`);
  process.exit(1);
}
