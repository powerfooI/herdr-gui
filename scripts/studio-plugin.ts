#!/usr/bin/env bun
// Thin Herdr plugin shim for Herdr Studio. Herdr invokes the verbs below
// through herdr-plugin.toml actions; the verb names and their argv mapping
// are a frozen contract because managed installs call the action set cached
// at install time.
//
// Verbs: build, start, restart, status, url, version, uninstall.
// `build` needs Bun on PATH; every other verb delegates to the compiled
// standalone binary and builds it first when missing (plugin link mode).

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

function build(): number {
  const install = run(["bun", "install"]);
  if (install !== 0) return install;
  return run(["bun", "run", "build"]);
}

function service(...args: string[]): number {
  let binary = binaryPath();
  if (!binary) {
    console.error("studio-plugin: herdr-gui binary missing, building it first");
    if (build() !== 0) return 1;
    binary = binaryPath();
    if (!binary) {
      console.error("studio-plugin: build finished but no binary was produced");
      return 1;
    }
  }
  return run([binary, "service", ...args]);
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

function printUrl(): number {
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
  } else {
    console.error(
      `studio-plugin: no service environment at ${envFile}, showing defaults`,
    );
  }
  const anyHost = host === "0.0.0.0" || host === "::";
  const browserHost = anyHost ? "localhost" : host;
  const formatted = browserHost.includes(":")
    ? `[${browserHost}]`
    : browserHost;
  let url = `http://${formatted}:${port}`;
  // Non-loopback binds log in with the generated token; loopback is open.
  const tokenPath = join(dir, "auth-token");
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) url = `${url}/?token=${token}`;
  }
  console.log(url);
  return 0;
}

function version(): number {
  const binary = binaryPath();
  if (binary) return run([binary, "--version"]);
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  console.log(`${packageJson.version ?? "unknown"} (binary not built)`);
  return 0;
}

function main(): number {
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
    default:
      console.error(
        "usage: studio-plugin.ts <build|start|restart|status|url|version|uninstall>",
      );
      return process.argv[2] ? 1 : 0;
  }
}

process.exit(main());
