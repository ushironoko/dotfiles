/**
 * Verifies the globally installed pi CLI matches the version pinned in
 * package.json devDependencies. Host-dependent (requires the pi binary), so
 * this is NOT part of run-all — it belongs to the machine smoke checklist in
 * pi/README.md.
 */
import { $ } from "bun";
import packageJson from "../package.json";

const PIN_KEY = "@earendil-works/pi-coding-agent";

const pinned: string | undefined = packageJson.devDependencies?.[PIN_KEY];
if (pinned === undefined) {
  console.error(
    `check-pi-version: ${PIN_KEY} is not pinned in package.json devDependencies`,
  );
  process.exit(1);
}

let installed: string;
try {
  installed = (await $`pi --version`.text()).trim();
} catch {
  console.error(
    `check-pi-version: pi binary not found. Install with: bun install -g ${PIN_KEY}@${pinned}`,
  );
  process.exit(1);
}

if (installed !== pinned) {
  console.error(
    `check-pi-version: installed pi ${installed} != pinned ${pinned}. ` +
      `Update the pin or run: bun install -g ${PIN_KEY}@${pinned}`,
  );
  process.exit(1);
}

console.log(`check-pi-version: OK (${installed})`);
