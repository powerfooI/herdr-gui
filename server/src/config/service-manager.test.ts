import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runServiceCommand } from "./service-manager";
import {
  renderLaunchdService,
  renderSystemdService,
} from "./service-definitions";

const tempDirs: string[] = [];

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "herdr-gui-service-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("service definition rendering", () => {
  test("escapes systemd paths without quoting them", () => {
    const definition = renderSystemdService(
      "/opt/Herdr % GUI/herdr-gui",
      "/srv/herdr gui/config/herdr-gui.env",
    );

    expect(definition).toContain(
      "EnvironmentFile=-/srv/herdr\\x20gui/config/herdr-gui.env",
    );
    expect(definition).not.toContain('EnvironmentFile="');
    expect(definition).toContain(
      "ExecStart=/opt/Herdr\\x20%%\\x20GUI/herdr-gui",
    );
    expect(definition).not.toContain('ExecStart="');
    expect(definition).toContain("Restart=always");
  });

  test("passes launchd paths as arguments without interpolating shell code", () => {
    const definition = renderLaunchdService("/Applications/Herdr & GUI", {
      config: "/srv/herdr & gui/config/herdr-gui.env",
      definition: "/unused.plist",
      stdoutLog: "/srv/herdr & gui/logs/out.log",
      stderrLog: "/srv/herdr & gui/logs/error.log",
    });

    expect(definition).toContain(
      "<string>/Applications/Herdr &amp; GUI</string>",
    );
    expect(definition).toContain(
      "<string>/srv/herdr &amp; gui/config/herdr-gui.env</string>",
    );
    expect(definition).toContain("<key>KeepAlive</key>");
    expect(definition).toContain("<key>HERDR_GUI_RESTART_SUPERVISOR</key>");
    expect(definition).toContain("exec &quot;$2&quot;");
  });
});

describe("service commands", () => {
  test("installs and starts a systemd user service", () => {
    const homeDir = tempHome();
    const commands: Array<{ argv: string[]; quiet: boolean }> = [];
    const logs: string[] = [];
    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui", "service", "install"],
        uid: 1000,
      },
      runCommand: (argv, options) => {
        commands.push({ argv, quiet: options?.quiet === true });
        return 0;
      },
      getLanIPs: () => ["192.0.2.23"],
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      {
        argv: ["systemctl", "--user", "daemon-reload"],
        quiet: false,
      },
      {
        argv: ["systemctl", "--user", "enable", "herdr-gui.service"],
        quiet: false,
      },
      {
        argv: ["systemctl", "--user", "restart", "herdr-gui.service"],
        quiet: false,
      },
    ]);
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    const configPath = join(homeDir, ".config", "herdr-gui", "herdr-gui.env");
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "ExecStart=/opt/herdr-gui-test/bin/herdr-gui",
    );
    expect(readFileSync(configPath, "utf8")).toContain("HOST=0.0.0.0");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const tokenPath = join(homeDir, ".config", "herdr-gui", "auth-token");
    const token = readFileSync(tokenPath, "utf8").trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("Installed systemd service");
    expect(logs.join("\n")).toContain(`Login token: ${token}`);
    expect(logs.join("\n")).toContain(
      `Open: http://localhost:8787/?token=${token}`,
    );
    expect(logs.join("\n")).toContain(
      `LAN: http://192.0.2.23:8787/?token=${token}`,
    );
  });

  test("reloads the systemd definition before restarting", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/bin/true\n");
    const commands: string[][] = [];

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui", "service", "reload"],
      },
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", "herdr-gui.service"],
    ]);
  });

  test("does not restart systemd when daemon-reload fails", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/bin/true\n");
    let commandCount = 0;

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui", "service", "reload"],
      },
      runCommand: () => {
        commandCount += 1;
        return 5;
      },
    });

    expect(code).toBe(5);
    expect(commandCount).toBe(1);
  });

  test("reports a missing service definition during reload", () => {
    const errors: string[] = [];
    let commandCount = 0;

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir: tempHome(),
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui", "service", "reload"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(commandCount).toBe(0);
    expect(errors.join("\n")).toContain(
      "cannot reload missing systemd service",
    );
  });

  test("preserves an existing environment file during reinstall", () => {
    const homeDir = tempHome();
    const configPath = join(homeDir, ".config", "herdr-gui", "herdr-gui.env");
    mkdirSync(join(homeDir, ".config", "herdr-gui"), { recursive: true });
    writeFileSync(configPath, "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=secret\n");
    chmodSync(configPath, 0o644);

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/usr/local/bin/herdr-gui",
        argv: ["/usr/local/bin/herdr-gui", "service", "install"],
      },
      runCommand: () => 0,
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(
      "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=secret\n",
    );
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(
      existsSync(join(homeDir, ".config", "herdr-gui", "auth-token")),
    ).toBe(false);
  });

  test("preserves a managed custom wrapper command", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    const binaryPath = join(homeDir, ".local", "bin", "herdr-gui");
    const wrapperPath = join(homeDir, ".local", "libexec", "service-wrapper");
    const wrapperCommand =
      `${wrapperPath} --service example -- ` + `${binaryPath} --host 0.0.0.0`;
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(
      definitionPath,
      `# Generated by herdr-gui service install.\n` +
        `[Service]\nExecStart=${wrapperCommand}\n`,
    );
    const logs: string[] = [];

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: binaryPath,
        argv: [binaryPath, "service", "install"],
      },
      runCommand: () => 0,
      getLanIPs: () => [],
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    const definition = readFileSync(definitionPath, "utf8");
    expect(definition).toContain(`ExecStart=${wrapperCommand}`);
    expect(definition).toContain("Restart=always");
    expect(logs).toContain(`Preserved custom ExecStart: ${wrapperCommand}`);
  });

  test("replaces a stale custom command that does not invoke this binary", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(
      definitionPath,
      `# Generated by herdr-gui service install.\n` +
        `[Service]\n` +
        `ExecStart=/usr/local/bin/service-wrapper -- ` +
        `/opt/herdr-gui-test/bin/herdr-gui-old\n`,
    );

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui", "service", "install"],
      },
      runCommand: () => 0,
      getLanIPs: () => [],
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "ExecStart=/opt/herdr-gui-test/bin/herdr-gui",
    );
  });

  test("refuses to overwrite an unmanaged service without force", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/custom/wrapper\n");
    const errors: string[] = [];
    let commandCount = 0;

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/usr/local/bin/herdr-gui",
        argv: ["/usr/local/bin/herdr-gui", "service", "install"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      log: () => undefined,
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(commandCount).toBe(0);
    expect(readFileSync(definitionPath, "utf8")).toContain("/custom/wrapper");
    expect(errors.join("\n")).toContain("rerun with --force");
  });

  test("validates launchd identity before writing service files", () => {
    const homeDir = tempHome();
    const errors: string[] = [];

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "darwin",
        homeDir,
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui"],
      },
      runCommand: () => {
        throw new Error("should not run");
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "cannot determine the current user id for launchd",
    );
    expect(() =>
      readFileSync(
        join(homeDir, ".config", "herdr-gui", "herdr-gui.env"),
        "utf8",
      ),
    ).toThrow();
    expect(() =>
      readFileSync(
        join(homeDir, "Library", "LaunchAgents", "dev.herdr.herdr-gui.plist"),
        "utf8",
      ),
    ).toThrow();
  });

  test("installs, inspects, restarts, reloads, and removes a launchd agent", () => {
    const homeDir = tempHome();
    const commands: Array<{ argv: string[]; quiet: boolean }> = [];
    const runtime = {
      platform: "darwin",
      homeDir,
      execPath: "/opt/herdr-gui-test/bin/herdr-gui",
      argv: ["/opt/herdr-gui-test/bin/herdr-gui"],
      uid: 501,
    };
    let launchdLoaded = false;
    const runCommand = (argv: string[], options?: { quiet?: boolean }) => {
      commands.push({ argv, quiet: options?.quiet === true });
      if (argv[1] === "print") return launchdLoaded ? 0 : 1;
      if (argv[1] === "bootstrap") launchdLoaded = true;
      if (argv[1] === "bootout") launchdLoaded = false;
      return 0;
    };

    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "status"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "restart"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "reload"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "uninstall"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);

    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "dev.herdr.herdr-gui.plist",
    );
    expect(() => readFileSync(plistPath, "utf8")).toThrow();
    expect(commands).toEqual([
      {
        argv: ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootstrap", "gui/501", plistPath],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
        quiet: false,
      },
      {
        argv: ["launchctl", "kickstart", "-k", "gui/501/dev.herdr.herdr-gui"],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootout", "gui/501/dev.herdr.herdr-gui"],
        quiet: false,
      },
      {
        argv: ["launchctl", "bootstrap", "gui/501", plistPath],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootout", "gui/501/dev.herdr.herdr-gui"],
        quiet: false,
      },
    ]);
    expect(
      readFileSync(
        join(homeDir, ".config", "herdr-gui", "herdr-gui.env"),
        "utf8",
      ),
    ).toContain("HOST=0.0.0.0");
  });

  test("does not install a development runtime as a service", () => {
    const errors: string[] = [];
    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "darwin",
        homeDir: tempHome(),
        execPath: "/opt/homebrew/bin/bun",
        argv: ["/opt/homebrew/bin/bun", "src/index.ts", "service", "install"],
        uid: 501,
      },
      runCommand: () => {
        throw new Error("should not run");
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "service install requires the standalone herdr-gui binary",
    );
  });

  test("does not bootstrap launchd when stopping the loaded job fails", () => {
    const homeDir = tempHome();
    const runtime = {
      platform: "darwin",
      homeDir,
      execPath: "/opt/herdr-gui-test/bin/herdr-gui",
      argv: ["/opt/herdr-gui-test/bin/herdr-gui"],
      uid: 501,
    };
    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand: (argv) => (argv[1] === "print" ? 1 : 0),
        log: () => undefined,
      }),
    ).toBe(0);

    let bootstrapCalled = false;
    const code = runServiceCommand(["service", "install"], {
      runtime,
      runCommand: (argv) => {
        if (argv[1] === "print") return 0;
        if (argv[1] === "bootout") return 5;
        if (argv[1] === "bootstrap") bootstrapCalled = true;
        return 0;
      },
      log: () => undefined,
    });

    expect(code).toBe(5);
    expect(bootstrapCalled).toBe(false);
  });

  test("keeps a managed systemd definition when stopping fails", () => {
    const homeDir = tempHome();
    const runtime = {
      platform: "linux",
      homeDir,
      execPath: "/opt/herdr-gui-test/bin/herdr-gui",
      argv: ["/opt/herdr-gui-test/bin/herdr-gui"],
    };
    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand: () => 0,
        log: () => undefined,
      }),
    ).toBe(0);

    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "herdr-gui.service",
    );
    const code = runServiceCommand(["service", "uninstall"], {
      runtime,
      runCommand: (argv) => (argv.includes("disable") ? 1 : 0),
      log: () => undefined,
    });

    expect(code).toBe(1);
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "Generated by herdr-gui service install.",
    );
  });

  test("treats uninstall without a managed definition as a no-op", () => {
    let commandCount = 0;
    const logs: string[] = [];
    const code = runServiceCommand(["service", "uninstall"], {
      runtime: {
        platform: "linux",
        homeDir: tempHome(),
        execPath: "/opt/herdr-gui-test/bin/herdr-gui",
        argv: ["/opt/herdr-gui-test/bin/herdr-gui"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    expect(commandCount).toBe(0);
    expect(logs.join("\n")).toContain("No managed systemd service found");
  });
});
