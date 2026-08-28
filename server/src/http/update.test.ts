import { describe, expect, test } from "bun:test";
import {
  compareVersion,
  createUpdateHandlers,
  isSupervisorManagedEnvironment,
  normalizeUpdateBaseUrl,
  parseUpdateChecksumFile,
  parseUpdateManifest,
  parseUpdateVersionFile,
  resolveUpdateTarget,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./update";
import { shQuote } from "../utils/process-utils";

const darwinRuntime = {
  platform: "darwin",
  arch: "arm64",
  execPath: "/Applications/herdr-gui",
  argv: ["bun", "/$bunfs/root/herdr-gui-darwin-arm64", "--port", "8781"],
};

const linuxRuntime = {
  platform: "linux",
  arch: "x64",
  execPath: "/opt/herdr-gui/herdr-gui",
  argv: ["bun", "/$bunfs/root/herdr-gui-linux-x64", "--port", "8781"],
};

const launchdEnvironment = {
  XPC_SERVICE_NAME: "dev.herdr.herdr-gui",
};
const systemdEnvironment = {
  INVOCATION_ID: "invocation-id",
};
const updateSha256 = "a".repeat(64);

function credentialBearingUpdateBaseUrl(): string {
  return [
    "https://",
    "example-user",
    ":",
    "example-password",
    "@downloads.example.com/herdr",
  ].join("");
}

function updateManifest(
  version: string,
  platform: string,
  archive = `herdr-gui-${platform}.tar.xz`,
  sha256 = updateSha256,
): string {
  return JSON.stringify({
    schema: 1,
    name: "herdr-gui",
    version,
    platform,
    archive,
    sha256,
  });
}

function updateCheckRequest() {
  return new Request("http://localhost/api/update/check", {
    headers: { "x-herdr-gui-update": "1" },
  });
}

function updateInstallRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/update/install", {
    method: "POST",
    headers: { "x-herdr-gui-update": "1", ...headers },
  });
}

describe("update helpers", () => {
  test("keeps HTTP requests alive for the full update budget", () => {
    expect(UPDATE_HTTP_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(165000);
    expect(UPDATE_HTTP_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  test("parses VERSION files", () => {
    expect(parseUpdateVersionFile("herdr-gui 0.2.6 linux-x64\n")).toEqual({
      version: "0.2.6",
      platform: "linux-x64",
    });
    expect(() => parseUpdateVersionFile("bad 0.2.6 linux-x64")).toThrow(
      "invalid update VERSION file",
    );
    expect(() =>
      parseUpdateVersionFile("herdr-gui 0.2.6 linux-x64 extra"),
    ).toThrow("invalid update VERSION file");
  });

  test("parses bounded update manifests and binds checksum filenames", () => {
    expect(parseUpdateManifest(updateManifest("0.2.17", "linux-x64"))).toEqual({
      schema: 1,
      name: "herdr-gui",
      version: "0.2.17",
      platform: "linux-x64",
      archive: "herdr-gui-linux-x64.tar.xz",
      sha256: updateSha256,
    });
    expect(() => parseUpdateManifest("{}")).toThrow("invalid update manifest");
    expect(() =>
      parseUpdateManifest(updateManifest("invalid", "linux-x64")),
    ).toThrow("invalid update manifest");
    expect(() => parseUpdateManifest("x".repeat(4097))).toThrow(
      "invalid update manifest",
    );

    expect(
      parseUpdateChecksumFile(
        `${updateSha256}  herdr-gui-linux-x64.tar.xz\n`,
        "herdr-gui-linux-x64.tar.xz",
      ),
    ).toBe(updateSha256);
    expect(() =>
      parseUpdateChecksumFile(
        `${updateSha256}  ../../unrelated-file\n`,
        "herdr-gui-linux-x64.tar.xz",
      ),
    ).toThrow("invalid update checksum file");
  });

  test("normalizes safe update base URLs without exposing credentials", () => {
    expect(normalizeUpdateBaseUrl(undefined)).toBe(
      "https://github.com/powerfooI/herdr-studio/releases/latest/download",
    );
    expect(
      normalizeUpdateBaseUrl(" https://downloads.example.com/herdr/// "),
    ).toBe("https://downloads.example.com/herdr");
    expect(normalizeUpdateBaseUrl("http://127.0.0.1:8080/releases/")).toBe(
      "http://127.0.0.1:8080/releases",
    );
    expect(() =>
      normalizeUpdateBaseUrl("http://downloads.example.com/herdr"),
    ).toThrow("must use HTTPS unless the mirror is loopback");
    expect(() =>
      normalizeUpdateBaseUrl(credentialBearingUpdateBaseUrl()),
    ).toThrow("must not contain credentials");
    expect(() =>
      normalizeUpdateBaseUrl(
        "https://downloads.example.com/herdr?token=secret",
      ),
    ).toThrow("must not contain a query or fragment");
  });

  test("compares release and prerelease versions numerically", () => {
    expect(compareVersion("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersion("0.2.0", "0.2")).toBe(0);
    expect(compareVersion("0.1.9", "0.2.0")).toBe(-1);
    expect(compareVersion("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersion("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(() => compareVersion("not-a-version", "1.0.0")).toThrow(
      "invalid update version",
    );
  });

  test("maps only published runtime architectures to update packages", () => {
    expect(resolveUpdateTarget("linux", "x64")).toEqual({
      platform: "linux-x64",
      packageDir: "herdr-gui-linux-x64",
      archiveName: "herdr-gui-linux-x64.tar.xz",
      manifestName: "herdr-gui-linux-x64.update.json",
    });
    expect(resolveUpdateTarget("darwin", "arm64")).toEqual({
      platform: "darwin-arm64",
      packageDir: "herdr-gui-darwin-arm64",
      archiveName: "herdr-gui-darwin-arm64.tar.xz",
      manifestName: "herdr-gui-darwin-arm64.update.json",
    });
    expect(resolveUpdateTarget("darwin", "x64")).toEqual({
      platform: "darwin-x64",
      packageDir: "herdr-gui-darwin-x64",
      archiveName: "herdr-gui-darwin-x64.tar.xz",
      manifestName: "herdr-gui-darwin-x64.update.json",
    });
    expect(resolveUpdateTarget("linux", "arm64")).toEqual({
      platform: "linux-arm64",
      packageDir: "herdr-gui-linux-arm64",
      archiveName: "herdr-gui-linux-arm64.tar.xz",
      manifestName: "herdr-gui-linux-arm64.update.json",
    });
    expect(resolveUpdateTarget("win32", "x64")).toBeNull();
  });

  test("detects systemd and launchd while allowing explicit overrides", () => {
    expect(
      isSupervisorManagedEnvironment({ INVOCATION_ID: "invocation-id" }),
    ).toBe(true);
    expect(
      isSupervisorManagedEnvironment({
        XPC_SERVICE_NAME: "dev.herdr.herdr-gui",
      }),
    ).toBe(true);
    expect(isSupervisorManagedEnvironment({ XPC_SERVICE_NAME: "0" })).toBe(
      false,
    );
    expect(
      isSupervisorManagedEnvironment({
        INVOCATION_ID: "invocation-id",
        HERDR_GUI_RESTART_SUPERVISOR: "0",
      }),
    ).toBe(false);
    expect(
      isSupervisorManagedEnvironment({
        HERDR_GUI_RESTART_SUPERVISOR: "1",
      }),
    ).toBe(true);
  });

  test("checks the package matching a Darwin arm64 standalone binary", async () => {
    const commands: string[] = [];
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv.join(" "));
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "darwin-arm64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      current_version: "0.2.16",
      latest_version: "0.2.17",
      update_available: true,
      can_auto_update: true,
      platform: "darwin-arm64",
      source_url:
        "https://github.com/powerfooI/herdr-studio/releases/latest/download/herdr-gui-darwin-arm64.tar.xz",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--max-filesize 4096");
    expect(commands[0]).toContain("herdr-gui-darwin-arm64.update.json");
    expect(commands[0]).not.toContain(".tar.xz");
    expect(commands[0]).not.toContain("herdr-gui-linux-x64");
  });

  test("keeps Linux x64 update checks on the Linux archive", async () => {
    const commands: string[] = [];
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv.join(" "));
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "linux-x64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: linuxRuntime,
      environment: systemdEnvironment,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      update_available: true,
      can_auto_update: true,
      platform: "linux-x64",
      source_url:
        "https://github.com/powerfooI/herdr-studio/releases/latest/download/herdr-gui-linux-x64.tar.xz",
    });
    expect(commands[0]).toContain("herdr-gui-linux-x64.update.json");
    expect(commands[0]).not.toContain(".tar.xz");
    expect(commands[0]).not.toContain("herdr-gui-darwin-arm64");
  });

  test("uses a configured release mirror", async () => {
    const commands: string[] = [];
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv.join(" "));
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "linux-x64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: linuxRuntime,
      environment: {
        ...systemdEnvironment,
        HERDR_GUI_UPDATE_BASE_URL: "https://downloads.example.com/herdr/",
      },
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source_url:
        "https://downloads.example.com/herdr/herdr-gui-linux-x64.tar.xz",
    });
    expect(commands[0]).toContain(
      "https://downloads.example.com/herdr/herdr-gui-linux-x64.update.json",
    );
  });

  test("caches successful metadata checks across browser clients", async () => {
    let callCount = 0;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "linux-x64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: linuxRuntime,
      environment: systemdEnvironment,
    });

    const [first, second] = await Promise.all([
      handlers.handleUpdateCheck(updateCheckRequest()),
      handlers.handleUpdateCheck(updateCheckRequest()),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(callCount).toBe(1);
    expect(first.headers.get("cache-control")).toBe("no-store");
  });

  test("falls back to bounded legacy release metadata", async () => {
    const commands: string[][] = [];
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv);
        if (commands.length === 1) {
          return { code: 22, stdout: "", stderr: "manifest not found" };
        }
        if (commands.length === 2) {
          return {
            code: 0,
            stdout: "herdr-gui 0.2.17 linux-x64\n",
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: `${updateSha256}  herdr-gui-linux-x64.tar.xz\n`,
          stderr: "",
        };
      },
      shQuote,
      runtime: linuxRuntime,
      environment: systemdEnvironment,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      latest_version: "0.2.17",
      update_available: true,
      platform: "linux-x64",
    });
    expect(commands).toHaveLength(3);
    expect(commands[0].join(" ")).toContain(".update.json");
    expect(commands[1][2]).toContain("tar -xJOf");
    expect(commands[2].join(" ")).toContain(".tar.xz.sha256");
    expect(commands[2].join(" ")).toContain("--max-filesize 4096");
  });

  test("rejects malformed manifests instead of treating them as legacy", async () => {
    let callCount = 0;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        return { code: 0, stdout: "{}", stderr: "" };
      },
      shQuote,
      runtime: linuxRuntime,
      environment: systemdEnvironment,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "invalid update manifest",
    });
    expect(callCount).toBe(1);
  });

  test("does not expose credentials from an invalid update base URL", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        throw new Error("should not run");
      },
      shQuote,
      runtime: linuxRuntime,
      environment: {
        ...systemdEnvironment,
        HERDR_GUI_UPDATE_BASE_URL: credentialBearingUpdateBaseUrl(),
      },
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "HERDR_GUI_UPDATE_BASE_URL must not contain credentials",
    });
    expect(JSON.stringify(body)).not.toContain("example-password");
  });

  test("does not check a mismatched package on unsupported architectures", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        throw new Error("should not run");
      },
      shQuote,
      runtime: {
        ...darwinRuntime,
        platform: "win32",
        arch: "x64",
      },
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      current_version: "0.2.16",
      update_available: false,
      can_auto_update: false,
      platform: "win32-x64",
      reason: "Auto update is not available for win32-x64.",
    });
  });

  test("checks for updates but refuses to replace a development runtime", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: updateManifest("0.2.17", "darwin-arm64"),
        stderr: "",
      }),
      shQuote,
      runtime: {
        ...darwinRuntime,
        execPath: "/opt/homebrew/bin/bun",
        argv: ["/opt/homebrew/bin/bun", "src/index.ts"],
      },
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      update_available: true,
      can_auto_update: false,
      reason: "Auto update is only available in the standalone binary.",
      platform: "darwin-arm64",
    });
  });

  test("checks for updates but requires an external supervisor to install", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: updateManifest("0.2.17", "darwin-arm64"),
        stderr: "",
      }),
      shQuote,
      runtime: darwinRuntime,
      environment: {},
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      update_available: true,
      can_auto_update: false,
      reason:
        "Automatic updates require an external process supervisor such as systemd or launchd.",
      platform: "darwin-arm64",
    });
  });

  test("requires an explicit browser confirmation header for update requests", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        throw new Error("should not run");
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
    });

    const checkResponse = await handlers.handleUpdateCheck(
      new Request("http://localhost/api/update/check"),
    );
    expect(checkResponse.status).toBe(403);
    expect(checkResponse.headers.get("cache-control")).toBe("no-store");
    expect(await checkResponse.json()).toEqual({
      error: "Update confirmation header is required.",
    });

    const installResponse = await handlers.handleUpdateInstall(
      new Request("http://localhost/api/update/install", { method: "POST" }),
    );
    expect(installResponse.status).toBe(403);
    expect(installResponse.headers.get("cache-control")).toBe("no-store");
    expect(await installResponse.json()).toEqual({
      error: "Update confirmation header is required.",
    });
  });

  test("rejects installation when no external supervisor owns restart", async () => {
    let callCount = 0;
    let exitScheduled = false;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "darwin-arm64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: {},
      scheduleProcessExit: () => {
        exitScheduled = true;
      },
    });

    const response = await handlers.handleUpdateInstall(updateInstallRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error:
        "Automatic updates require an external process supervisor such as systemd or launchd.",
      current_version: "0.2.16",
    });
    expect(callCount).toBe(0);
    expect(exitScheduled).toBe(false);
  });

  test("rejects a release archive whose platform metadata does not match", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: updateManifest("0.2.17", "linux-x64"),
        stderr: "",
      }),
      shQuote,
      runtime: darwinRuntime,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "latest update platform is linux-x64, expected darwin-arm64",
    });
  });

  test("installs a Darwin update and schedules only the managed process exit", async () => {
    const commands: string[][] = [];
    let exitScheduled = false;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv);
        if (commands.length === 1) {
          return {
            code: 0,
            stdout: updateManifest("0.2.17", "darwin-arm64"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
      scheduleProcessExit: () => {
        exitScheduled = true;
      },
    });

    const response = await handlers.handleUpdateInstall(updateInstallRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      installed: true,
      installed_version: "0.2.17",
      restart_required: true,
      restart_scheduled: true,
      restart_mode: "supervisor",
      target_path: "/Applications/herdr-gui",
    });
    expect(commands).toHaveLength(2);
    const installCommand = commands[1][2];
    expect(installCommand).toContain("herdr-gui-darwin-arm64.tar.xz");
    expect(installCommand).not.toContain(".sha256");
    expect(installCommand).toContain(`expected_sha256='${updateSha256}'`);
    expect(installCommand).toContain('shasum -a 256 "$archive"');
    expect(installCommand).toContain('sha256sum "$archive"');
    expect(installCommand).toContain('version_file="$package_dir/VERSION"');
    expect(installCommand).toContain('binary="$package_dir/herdr-gui"');
    expect(installCommand).toContain('tar -xJf "$archive" -C "$tmp"');
    expect(installCommand).toContain("'herdr-gui-darwin-arm64/VERSION'");
    expect(installCommand).toContain("'herdr-gui-darwin-arm64/herdr-gui'");
    expect(installCommand).toContain("target='/Applications/herdr-gui'");
    expect(installCommand).toContain('backup="$target.previous"');
    expect(installCommand).toContain('mktemp "$target_dir/.$target_base.new.');
    expect(installCommand).not.toContain("herdr-gui-linux-x64");
    expect(
      Bun.spawnSync(["sh", "-n"], {
        stdin: Buffer.from(installCommand),
      }).exitCode,
    ).toBe(0);
    expect(exitScheduled).toBe(true);
  });

  test("serializes update installs across connected clients", async () => {
    let releaseVersionCheck: () => void = () => {};
    let markVersionCheckStarted: () => void = () => {};
    const versionCheckStarted = new Promise<void>((resolve) => {
      markVersionCheckStarted = resolve;
    });
    const versionCheckGate = new Promise<void>((resolve) => {
      releaseVersionCheck = resolve;
    });
    let callCount = 0;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        if (callCount === 1) {
          markVersionCheckStarted();
          await versionCheckGate;
          return {
            code: 0,
            stdout: updateManifest("0.2.17", "darwin-arm64"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
      scheduleProcessExit: () => undefined,
    });

    const firstInstall = handlers.handleUpdateInstall(updateInstallRequest());
    await versionCheckStarted;
    const concurrentResponse = await handlers.handleUpdateInstall(
      updateInstallRequest(),
    );
    expect(concurrentResponse.status).toBe(409);
    expect(await concurrentResponse.json()).toMatchObject({
      error: "An update installation is already in progress.",
    });

    releaseVersionCheck();
    const firstResponse = await firstInstall;
    expect(firstResponse.status).toBe(200);
    expect(callCount).toBe(2);
    const restartWindowResponse = await handlers.handleUpdateInstall(
      updateInstallRequest(),
    );
    expect(restartWindowResponse.status).toBe(409);
    expect(callCount).toBe(2);
  });

  test("does not download an update when the current version is latest", async () => {
    let callCount = 0;
    let exitScheduled = false;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.17",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        return {
          code: 0,
          stdout: updateManifest("0.2.17", "darwin-arm64"),
          stderr: "",
        };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
      scheduleProcessExit: () => {
        exitScheduled = true;
      },
    });

    const response = await handlers.handleUpdateInstall(updateInstallRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      installed: false,
      current_version: "0.2.17",
      latest_version: "0.2.17",
      message: "Already up to date.",
    });
    expect(callCount).toBe(1);
    expect(exitScheduled).toBe(false);
  });

  test("returns an install failure without scheduling a restart", async () => {
    let callCount = 0;
    let exitScheduled = false;
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        callCount += 1;
        return callCount % 2 === 1
          ? {
              code: 0,
              stdout: updateManifest("0.2.17", "darwin-arm64"),
              stderr: "",
            }
          : { code: 1, stdout: "", stderr: "install failed" };
      },
      shQuote,
      runtime: darwinRuntime,
      environment: launchdEnvironment,
      scheduleProcessExit: () => {
        exitScheduled = true;
      },
    });

    const response = await handlers.handleUpdateInstall(updateInstallRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "install failed",
      current_version: "0.2.16",
      latest_version: "0.2.17",
    });
    expect(callCount).toBe(2);
    expect(exitScheduled).toBe(false);

    const retryResponse = await handlers.handleUpdateInstall(
      updateInstallRequest(),
    );
    expect(retryResponse.status).toBe(500);
    expect(callCount).toBe(4);
  });

  test("rejects install requests on unsupported architectures before download", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.16",
      runProcessWithCodeTimeout: async () => {
        throw new Error("should not run");
      },
      shQuote,
      runtime: {
        ...darwinRuntime,
        platform: "win32",
        arch: "x64",
      },
    });

    const response = await handlers.handleUpdateInstall(updateInstallRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Auto update is not available for win32-x64.",
      current_version: "0.2.16",
    });
  });

  test("reports disabled update checks without running curl", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.6",
      runProcessWithCodeTimeout: async () => {
        throw new Error("should not run");
      },
      shQuote,
      environment: { HERDR_GUI_DISABLE_UPDATE_CHECK: "1" },
    });
    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      current_version: "0.2.6",
      update_available: false,
      can_auto_update: false,
      reason: "Update checks are disabled by HERDR_GUI_DISABLE_UPDATE_CHECK.",
    });
  });

  test("returns a 502 when update checks fail", async () => {
    const handlers = createUpdateHandlers({
      appVersion: "0.2.6",
      runProcessWithCodeTimeout: async () => ({
        code: 22,
        stdout: "",
        stderr: "curl failed",
      }),
      shQuote,
    });

    const response = await handlers.handleUpdateCheck(updateCheckRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "curl failed" });
  });
});
