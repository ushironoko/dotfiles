/**
 * Verifies the globally installed pi CLI matches the version pinned in
 * package.json devDependencies. Host-dependent (requires the pi binary), so
 * this is NOT part of run-all — it belongs to the machine smoke checklist in
 * pi/README.md.
 */
import { posix, win32 } from "node:path";
import packageJson from "../package.json";

const PIN_KEY = "@earendil-works/pi-coding-agent";

type CommandRunner = (argv: string[]) => Promise<string>;

const runCommand: CommandRunner = async (argv) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`command failed: ${argv[0]}`);
  return output.trim();
};

const readGlobalPiVersion = async (
  run: CommandRunner = runCommand,
  bunExecutable = process.execPath,
  platform = process.platform,
): Promise<string> => {
  const globalBin = await run([bunExecutable, "pm", "bin", "--global"]);
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(globalBin)) {
    throw new Error("Bun global bin directory is not absolute");
  }
  const executable = platform === "win32" ? "pi.exe" : "pi";
  return run([pathApi.join(globalBin, executable), "--version"]);
};

const main = async (): Promise<number> => {
  const pinned: string | undefined = packageJson.devDependencies?.[PIN_KEY];
  if (pinned === undefined) {
    console.error(
      `check-pi-version: ${PIN_KEY} is not pinned in package.json devDependencies`,
    );
    return 1;
  }

  let installed: string;
  try {
    installed = await readGlobalPiVersion();
  } catch {
    console.error(
      `check-pi-version: global pi binary not found. Install with: bun install -g ${PIN_KEY}@${pinned}`,
    );
    return 1;
  }

  if (installed !== pinned) {
    console.error(
      `check-pi-version: globally installed pi ${installed} != pinned ${pinned}. ` +
        `Update the pin or run: bun install -g ${PIN_KEY}@${pinned}`,
    );
    return 1;
  }

  console.log(`check-pi-version: OK (${installed})`);
  return 0;
};

if (import.meta.main) process.exit(await main());

export { main, readGlobalPiVersion };
