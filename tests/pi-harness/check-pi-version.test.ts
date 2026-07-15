import { describe, expect, test } from "bun:test";
import { readGlobalPiVersion } from "../../scripts/check-pi-version";

describe("readGlobalPiVersion", () => {
  test("executes pi from Bun's global bin instead of PATH", async () => {
    const calls: string[][] = [];
    const outputs = ["/tmp/bun-global-bin", "0.80.7"];

    const version = await readGlobalPiVersion(
      async (argv) => {
        calls.push(argv);
        return outputs.shift() ?? "";
      },
      "/opt/bun/bin/bun",
      "darwin",
    );

    expect(version).toBe("0.80.7");
    expect(calls).toEqual([
      ["/opt/bun/bin/bun", "pm", "bin", "--global"],
      ["/tmp/bun-global-bin/pi", "--version"],
    ]);
    expect(calls[1]?.[0]).not.toBe("pi");
  });

  test("uses the Windows executable name", async () => {
    const calls: string[][] = [];

    await readGlobalPiVersion(
      async (argv) => {
        calls.push(argv);
        return calls.length === 1 ? String.raw`C:\bun\bin` : "0.80.7";
      },
      String.raw`C:\bun\bin\bun.exe`,
      "win32",
    );

    expect(calls[1]?.[0]).toBe(String.raw`C:\bun\bin\pi.exe`);
  });

  test("rejects a non-absolute global bin instead of falling back to PATH", async () => {
    const calls: string[][] = [];

    const promise = readGlobalPiVersion(async (argv) => {
      calls.push(argv);
      return "relative-bin";
    });

    await expect(promise).rejects.toThrow("not absolute");
    expect(calls).toHaveLength(1);
  });
});
