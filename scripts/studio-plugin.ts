#!/usr/bin/env bun
// Thin Herdr plugin shim for Herdr Studio. Herdr invokes the verbs below
// through herdr-plugin.toml actions; the verb names and their argv mapping
// are a frozen contract because managed installs call the action set cached
// at install time.
//
// Verbs: build, start, restart, status, url, version, uninstall, panel.
// `build` needs Bun on PATH; every other verb delegates to the compiled
// standalone binary and builds it first when missing (plugin link mode).
// `panel` is the interactive popup TUI behind the manifest [[panes]] entry.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

function run(argv: string[]): number {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
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

function build(): number {
  const install = run(["bun", "install"]);
  if (install !== 0) return install;
  return run(["bun", "run", "build"]);
}

function ensureBinary(): string | null {
  const existing = binaryPath();
  if (existing) return existing;
  console.error("studio-plugin: herdr-gui binary missing, building it first");
  if (build() !== 0) return null;
  const built = binaryPath();
  if (!built) {
    console.error("studio-plugin: build finished but no binary was produced");
  }
  return built;
}

function service(...args: string[]): number {
  const binary = ensureBinary();
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

function computeUrl(): string {
  const dir = configDir();
  const envFile = join(dir, "herdr-gui.env");
  let host = "127.0.0.1";
  let port = "8787";
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = /^(HOST|PORT)=(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === "HOST") host = match[2].trim();
      if (match[1] === "PORT") port = match[2].trim();
    }
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
    const cleanup = (code: number) => {
      process.stdout.write("\x1b[?25h\x1b[0m\n");
      stdin.setRawMode(false);
      stdin.pause();
      resolve(code);
    };
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
      if (!args) return;
      const binary = ensureBinary();
      if (!binary) {
        message = "build failed";
        renderPanel(message);
        return;
      }
      message = "working...";
      renderPanel(message);
      const result = capture([binary, "service", ...args]);
      const detail = (result.err || result.out).trim().split("\n").pop() ?? "";
      message =
        result.code === 0 ? "done" : `failed (exit ${result.code}): ${detail}`;
      renderPanel(message);
    });
    renderPanel(message);
  });
}

async function main(): Promise<number> {
  switch (process.argv[2]) {
    case "build":
      return build();
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
        "usage: studio-plugin.ts <build|start|restart|status|url|version|uninstall|panel>",
      );
      return process.argv[2] ? 1 : 0;
  }
}

process.exit(await main());
