#!/usr/bin/env bun
// Thin Herdr plugin shim for Herdr Studio. Herdr invokes the verbs below
// through herdr-plugin.toml actions; the verb names and their argv mapping
// are a frozen contract because managed installs call the action set cached
// at install time.
//
// Verbs: build, build-source, start, restart, status, url, version,
// uninstall, panel. The whole shim runs on Bun. `build` downloads the
// checksum-verified prebuilt release binary matching this checkout's
// version; `build-source` compiles from source for development. The service
// verbs (start, restart, status, uninstall) delegate to the binary,
// downloading it first when missing. `url` and `version` only read on-disk
// state. `panel` is the interactive popup TUI behind the manifest [[panes]]
// entry and downloads on demand for its service keys.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BINARY_CANDIDATES =
  process.platform === "win32" ? ["herdr-gui.exe", "herdr-gui"] : ["herdr-gui"];

function binaryPath(): string | null {
  for (const name of BINARY_CANDIDATES) {
    const path = join(REPO_ROOT, "server", name);
    if (existsSync(path)) return path;
  }
  return null;
}

function run(argv: string[], cwd = REPO_ROOT): number {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `studio-plugin: cannot run ${argv[0]}: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

function capture(argv: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) return { code: 1, out: "", err: result.error.message };
  return {
    code: result.status ?? 1,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

// Release archives ship one prebuilt binary per platform; `build` downloads
// and checksum-verifies the archive matching this checkout's version, so
// plugin users never need a source toolchain. `build-source` compiles from
// source and remains for development.
export const PLATFORM_ASSETS: Record<
  string,
  { asset: string; binary: string }
> = {
  "darwin-arm64": { asset: "herdr-gui-darwin-arm64", binary: "herdr-gui" },
  "darwin-x64": { asset: "herdr-gui-darwin-x64", binary: "herdr-gui" },
  "linux-arm64": { asset: "herdr-gui-linux-arm64", binary: "herdr-gui" },
  "linux-x64": { asset: "herdr-gui-linux-x64", binary: "herdr-gui" },
  "win32-arm64": { asset: "herdr-gui-windows-arm64", binary: "herdr-gui.exe" },
  "win32-x64": { asset: "herdr-gui-windows-x64", binary: "herdr-gui.exe" },
};

const RELEASE_REPOSITORY = "powerfooI/herdr-studio";

export function releaseAssetFor(
  platform: string,
  arch: string,
): { asset: string; binary: string } | null {
  return PLATFORM_ASSETS[`${platform}-${arch}`] ?? null;
}

export function parseSha256File(text: string): string | null {
  const match = /\b([0-9a-f]{64})\b/.exec(text);
  return match?.[1] ?? null;
}

async function downloadPrebuilt(): Promise<number> {
  const target = releaseAssetFor(process.platform, process.arch);
  if (!target) {
    console.error(
      `studio-plugin: no prebuilt binary for ${process.platform}-${process.arch}`,
    );
    return 1;
  }
  const version = packageVersion();
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  const archiveName = `${target.asset}.tar.xz`;
  console.error(`studio-plugin: downloading ${archiveName} (v${version})`);
  let tmp: string | null = null;
  try {
    const [checksumResponse, archiveResponse] = await Promise.all([
      fetch(`${base}/${archiveName}.sha256`),
      fetch(`${base}/${archiveName}`),
    ]);
    if (!checksumResponse.ok || !archiveResponse.ok) {
      console.error(
        `studio-plugin: download failed (checksum HTTP ${checksumResponse.status}, archive HTTP ${archiveResponse.status}); does release v${version} exist?`,
      );
      return 1;
    }
    const expected = parseSha256File(await checksumResponse.text());
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const actual = createHash("sha256").update(archive).digest("hex");
    if (!expected || actual !== expected) {
      console.error(
        `studio-plugin: checksum mismatch (expected ${expected ?? "<none>"}, got ${actual})`,
      );
      return 1;
    }
    tmp = mkdtempSync(join(tmpdir(), "studio-plugin-"));
    const archivePath = join(tmp, archiveName);
    writeFileSync(archivePath, archive);
    const extract = spawnSync("tar", ["-xJf", archivePath, "-C", tmp], {
      encoding: "utf8",
    });
    if (extract.error) {
      console.error(
        `studio-plugin: cannot run tar: ${extract.error.message} (tar with xz support is required)`,
      );
      return 1;
    }
    if (extract.status !== 0) {
      console.error(
        `studio-plugin: extraction failed (exit ${extract.status}): ${extract.stderr.trim()}`,
      );
      return 1;
    }
    const extracted = join(tmp, target.asset, target.binary);
    const serverDir = join(REPO_ROOT, "server");
    mkdirSync(serverDir, { recursive: true });
    const destination = join(serverDir, target.binary);
    copyFileSync(extracted, destination);
    if (process.platform !== "win32") chmodSync(destination, 0o755);
    console.error(`studio-plugin: installed ${target.binary} ${version}`);
    return 0;
  } catch (error) {
    console.error(
      `studio-plugin: download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function buildSource(): number {
  // This repo is not a Bun workspace: web/ and server/ carry their own
  // dependencies, so a clean checkout needs an install in each location.
  for (const dir of [".", "web", "server"]) {
    const code = run(["bun", "install"], join(REPO_ROOT, dir));
    if (code !== 0) return code;
  }
  return run(["bun", "run", "build"]);
}

async function ensureBinary(): Promise<string | null> {
  const existing = binaryPath();
  if (existing) return existing;
  console.error(
    "studio-plugin: herdr-gui binary missing, downloading it first",
  );
  if ((await downloadPrebuilt()) !== 0) return null;
  const downloaded = binaryPath();
  if (!downloaded) {
    console.error(
      "studio-plugin: download finished but no binary was produced",
    );
  }
  return downloaded;
}

async function service(...args: string[]): Promise<number> {
  const binary = await ensureBinary();
  if (!binary) return 1;
  return run([binary, "service", ...args]);
}

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  return packageJson.version ?? "unknown";
}

function configDir(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "herdr-gui",
    );
  }
  return join(homedir(), ".config", "herdr-gui");
}

// Mirrors the server's service env parser: leading whitespace, an optional
// `export` prefix, whitespace around `=`, and optionally quoted values; the
// last occurrence wins.
export function readServiceEnv(
  contents: string,
  name: string,
): string | undefined {
  let value: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`),
    );
    if (!match) continue;
    const raw = match[1] ?? "";
    value =
      raw.length >= 2 &&
      (raw.startsWith("'") || raw.startsWith('"')) &&
      raw.at(-1) === raw[0]
        ? raw.slice(1, -1)
        : raw;
  }
  return value;
}

export function computeUrl(dir = configDir()): string {
  const envFile = join(dir, "herdr-gui.env");
  let host = "127.0.0.1";
  let port = "8787";
  if (existsSync(envFile)) {
    const contents = readFileSync(envFile, "utf8");
    host = readServiceEnv(contents, "HOST") ?? host;
    port = readServiceEnv(contents, "PORT") ?? port;
  }
  const anyHost = host === "0.0.0.0" || host === "::";
  const browserHost = anyHost ? "localhost" : host;
  const formatted = browserHost.includes(":")
    ? `[${browserHost}]`
    : browserHost;
  let url = `http://${formatted}:${port}`;
  // Only non-loopback binds require the generated login token (the server
  // skips auth on loopback); the token file can also be absent or stale.
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  const tokenPath = join(dir, "auth-token");
  if (!loopback && existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) url = `${url}/?token=${encodeURIComponent(token)}`;
  }
  return url;
}

function printUrl(): number {
  const envFile = join(configDir(), "herdr-gui.env");
  if (!existsSync(envFile)) {
    console.error(
      `studio-plugin: no service environment at ${envFile}, showing defaults`,
    );
  }
  console.log(computeUrl());
  return 0;
}

function versionText(): string {
  const binary = binaryPath();
  if (binary) {
    const result = capture([binary, "--version"]);
    if (result.code === 0) return result.out.trim();
  }
  return `${packageVersion()} (binary not built)`;
}

function version(): number {
  console.log(versionText());
  return 0;
}

function statusText(): string {
  const binary = binaryPath();
  if (!binary) return "binary not built";
  const result = capture([binary, "service", "status"]);
  if (result.code !== 0) return "not installed";
  const firstLine = result.out.trim().split("\n")[0]?.trim();
  return firstLine || "installed";
}

function renderPanel(message: string) {
  const lines = [
    "Herdr Studio",
    "",
    `Status:  ${statusText()}`,
    `URL:     ${computeUrl()}`,
    `Version: ${versionText()}`,
    "",
    "[s] start  [r] restart  [u] uninstall  [q] close",
  ];
  if (message) lines.push("", message);
  process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`);
}

function panel(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.log(`Status:  ${statusText()}`);
    console.log(`URL:     ${computeUrl()}`);
    console.log(`Version: ${versionText()}`);
    return Promise.resolve(0);
  }
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let message = "";
    let done = false;
    let busy = false;
    const cleanup = (code: number) => {
      if (done) return;
      done = true;
      process.stdout.write("\x1b[?25h\x1b[0m\n");
      stdin.setRawMode(false);
      stdin.pause();
      resolve(code);
    };
    // The host can end the session by closing stdin or signaling the
    // process; leave the terminal restored in every exit path.
    stdin.on("end", () => cleanup(0));
    stdin.on("close", () => cleanup(0));
    process.on("SIGTERM", () => cleanup(0));
    process.on("SIGINT", () => cleanup(0));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "\x03") {
        cleanup(0);
        return;
      }
      const args =
        key === "s"
          ? ["install", "--force"]
          : key === "r"
            ? ["restart"]
            : key === "u"
              ? ["uninstall"]
              : null;
      if (!args || busy) return;
      busy = true;
      message = "working...";
      renderPanel(message);
      void (async () => {
        const binary = await ensureBinary();
        if (done) return;
        if (!binary) {
          message = "download failed";
        } else {
          const result = capture([binary, "service", ...args]);
          const detail =
            (result.err || result.out).trim().split("\n").pop() ?? "";
          message =
            result.code === 0
              ? "done"
              : `failed (exit ${result.code}): ${detail}`;
        }
        busy = false;
        renderPanel(message);
      })();
    });
    renderPanel(message);
  });
}

async function main(): Promise<number> {
  switch (process.argv[2]) {
    case "build":
      return downloadPrebuilt();
    case "build-source":
      return buildSource();
    case "start":
      return service("install", "--force");
    case "restart":
      return service("restart");
    case "status":
      return service("status");
    case "url":
      return printUrl();
    case "version":
      return version();
    case "uninstall":
      return service("uninstall");
    case "panel":
      return panel();
    default:
      console.error(
        "usage: studio-plugin.ts <build|build-source|start|restart|status|url|version|uninstall|panel>",
      );
      return process.argv[2] ? 1 : 0;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
