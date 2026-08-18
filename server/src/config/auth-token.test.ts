import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAuthTokenPath, loadOrCreateAuthToken } from "./auth-token";

const tempDirs: string[] = [];

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "herdr-gui-auth-token-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("generated authentication token", () => {
  test("creates a persistent random token with private permissions", () => {
    const path = defaultAuthTokenPath(tempHome());
    const first = loadOrCreateAuthToken(path);
    const second = loadOrCreateAuthToken(path);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(`${first}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("repairs permissions on an existing valid token", () => {
    const path = defaultAuthTokenPath(tempHome());
    const token = "a".repeat(64);
    loadOrCreateAuthToken(path);
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o644);

    expect(loadOrCreateAuthToken(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects a malformed persisted token", () => {
    const path = defaultAuthTokenPath(tempHome());
    loadOrCreateAuthToken(path);
    writeFileSync(path, "not-a-token\n");

    expect(() => loadOrCreateAuthToken(path)).toThrow(
      "invalid generated auth token",
    );
  });

  test("does not follow a generated-token symlink", () => {
    const home = tempHome();
    const path = defaultAuthTokenPath(home);
    const target = join(home, "shared-secret");
    loadOrCreateAuthToken(path);
    writeFileSync(target, `${"b".repeat(64)}\n`);
    rmSync(path);
    symlinkSync(target, path);

    expect(() => loadOrCreateAuthToken(path)).toThrow(
      "generated auth token path is not a regular file",
    );
  });
});
