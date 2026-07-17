/**
 * Backward-compatible entrypoint for the old exact-version check.
 *
 * The local package pin is now a reproducible test baseline, not a global
 * allowlist. The command succeeds for a different global version only after
 * public declaration compilation and an isolated real-pi RPC smoke pass.
 */
import { posix, win32 } from "node:path";
import { checkPiCompatibility } from "./pi-compat/index";

type VersionCommandRunner = (argv: string[]) => Promise<string>;

const runVersionCommand: VersionCommandRunner = async (argv) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`command failed: ${argv[0]}`);
  return output.trim();
};

const readGlobalPiVersion = async (
  run: VersionCommandRunner = runVersionCommand,
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
  try {
    const { baseline, installation } = await checkPiCompatibility();
    const baselineVersion = baseline.packages.find(
      ({ name }) => name === "@earendil-works/pi-coding-agent",
    )?.lockedVersion;
    const drift =
      baselineVersion === installation.packageVersion
        ? ""
        : `; local baseline ${baselineVersion ?? "unknown"}`;
    console.log(
      `check-pi-compat: OK (global ${installation.packageVersion}${drift})`,
    );
    return 0;
  } catch (error) {
    console.error(`check-pi-compat: FAILED: ${String(error)}`);
    return 1;
  }
};

if (import.meta.main) process.exit(await main());

export { main, readGlobalPiVersion };
