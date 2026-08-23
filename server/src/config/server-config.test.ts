import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrConfigDir, nativeSocketPath } from "./server-config";

describe("herdrConfigDir", () => {
  test("uses APPDATA on win32", () => {
    const appData = join("C:", "Users", "tester", "AppData", "Roaming");
    expect(herdrConfigDir("win32", appData)).toBe(join(appData, "herdr"));
  });

  test("falls back under the home directory on win32 without APPDATA", () => {
    expect(herdrConfigDir("win32", null)).toBe(
      join(homedir(), "AppData", "Roaming", "herdr"),
    );
  });

  test("uses the XDG-style config dir on other platforms", () => {
    expect(herdrConfigDir("darwin")).toBe(join(homedir(), ".config", "herdr"));
    expect(herdrConfigDir("linux")).toBe(join(homedir(), ".config", "herdr"));
  });
});

describe("nativeSocketPath", () => {
  test("maps Herdr's Windows socket name onto its named pipe", () => {
    const logical = String.raw`C:\Users\tester\AppData\Roaming\herdr\herdr.sock`;
    const native = String.raw`\\.\pipe\C:\Users\tester\AppData\Roaming\herdr\herdr.sock`;

    expect(nativeSocketPath(logical, "win32")).toBe(native);
    expect(nativeSocketPath(native, "win32")).toBe(native);
    const upperPrefix = String.raw`\\.\PIPE\existing`;
    expect(nativeSocketPath(upperPrefix, "win32")).toBe(upperPrefix);
    expect(nativeSocketPath(logical, "linux")).toBe(logical);
  });
});
