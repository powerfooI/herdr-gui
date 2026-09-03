import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeUrl, readServiceEnv } from "./studio-plugin";

describe("readServiceEnv", () => {
  test("reads plain values", () => {
    expect(readServiceEnv("HOST=0.0.0.0\nPORT=8791\n", "HOST")).toBe("0.0.0.0");
    expect(readServiceEnv("HOST=0.0.0.0\nPORT=8791\n", "PORT")).toBe("8791");
  });

  test("accepts export prefix, whitespace, and quoted values", () => {
    const contents = "export HOST=\"0.0.0.0\"\n  PORT = '8799'\n";
    expect(readServiceEnv(contents, "HOST")).toBe("0.0.0.0");
    expect(readServiceEnv(contents, "PORT")).toBe("8799");
  });

  test("last occurrence wins and missing keys are undefined", () => {
    expect(readServiceEnv("PORT=1\nPORT=2\n", "PORT")).toBe("2");
    expect(readServiceEnv("HOST=x\n", "PORT")).toBeUndefined();
  });

  test("ignores comments and unrelated keys", () => {
    const contents =
      "# HOST=10.0.0.1\nHERDR_GUI_LOG_LEVEL=info\nHOST=127.0.0.1\n";
    expect(readServiceEnv(contents, "HOST")).toBe("127.0.0.1");
  });
});

describe("computeUrl", () => {
  const dirs: string[] = [];
  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "studio-plugin-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  test("defaults to loopback when no env file exists", () => {
    expect(computeUrl(fixture({}))).toBe("http://127.0.0.1:8787");
  });

  test("includes the login token only for non-loopback binds", () => {
    const dir = fixture({
      "herdr-gui.env": "HOST=0.0.0.0\nPORT=8791\n",
      "auth-token": "abc123\n",
    });
    expect(computeUrl(dir)).toBe("http://localhost:8791/?token=abc123");
  });

  test("ignores a stale token file on loopback binds", () => {
    const dir = fixture({
      "herdr-gui.env": "HOST=127.0.0.1\nPORT=8787\n",
      "auth-token": "abc123\n",
    });
    expect(computeUrl(dir)).toBe("http://127.0.0.1:8787");
  });

  test("honors exported and quoted entries without a token file", () => {
    const dir = fixture({
      "herdr-gui.env": 'export HOST="0.0.0.0"\nPORT = "8799"\n',
    });
    expect(computeUrl(dir)).toBe("http://localhost:8799");
  });
});
