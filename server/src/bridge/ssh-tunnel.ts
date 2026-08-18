import { existsSync, rmSync } from "node:fs";
import type { ServerConfig } from "../config/server-config";

type RunProcess = (
  argv: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string }>;

export function createSshTunnelManager(args: {
  config: ServerConfig;
  runProcess: RunProcess;
}) {
  let cachedRemoteHome: { host: string; home: string } | null = null;
  let autoSshTunnel: ReturnType<typeof Bun.spawn> | null = null;
  let autoSshTunnelPaths: string[] = [];

  async function remoteHome(host: string): Promise<string> {
    if (cachedRemoteHome?.host === host) return cachedRemoteHome.home;
    const { stdout } = await args.runProcess([
      "ssh",
      host,
      `printf %s "$HOME"`,
    ]);
    const home = stdout.trim();
    if (!home.startsWith("/")) {
      throw new Error(`could not resolve remote HOME for ${host}`);
    }
    cachedRemoteHome = { host, home };
    return home;
  }

  async function remoteHerdrSocketPath(
    host: string,
    kind: "control" | "client",
  ): Promise<string> {
    const home = await remoteHome(host);
    const base = `${home}/.config/herdr`;
    const filename = kind === "control" ? "herdr.sock" : "herdr-client.sock";
    if (args.config.session) {
      return `${base}/sessions/${args.config.session}/${filename}`;
    }
    return `${base}/${filename}`;
  }

  function waitForLocalSockets(
    paths: string[],
    timeoutMs = 8000,
  ): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (paths.every((path) => existsSync(path))) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `ssh tunnel did not create local socket(s): ${paths.join(", ")}`,
            ),
          );
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function startAutoSshTunnel(): Promise<void> {
    const host = args.config.sshHost;
    if (!host) return;

    const forwards: Array<{ local: string; remote: string; label: string }> =
      [];
    if (!args.config.hasExplicitSocketPath) {
      forwards.push({
        local: args.config.socketPath,
        remote: await remoteHerdrSocketPath(host, "control"),
        label: "herdr socket",
      });
    }
    if (!args.config.hasExplicitClientSocketPath) {
      forwards.push({
        local: args.config.clientSocketPath,
        remote: await remoteHerdrSocketPath(host, "client"),
        label: "herdr client socket",
      });
    }
    if (forwards.length === 0) return;

    autoSshTunnelPaths = forwards.map((forward) => forward.local);
    for (const path of autoSshTunnelPaths) {
      rmSync(path, { force: true });
    }

    const argv = [
      "ssh",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=20",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StreamLocalBindUnlink=yes",
    ];
    for (const forward of forwards) {
      argv.push("-L", `${forward.local}:${forward.remote}`);
    }
    argv.push(host);

    console.log(`[bridge] starting SSH tunnel to ${host}`);
    for (const forward of forwards) {
      console.log(
        `[bridge]   ${forward.label}: ${forward.local} -> ${forward.remote}`,
      );
    }

    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    autoSshTunnel = proc;

    const outcome = await Promise.race([
      waitForLocalSockets(autoSshTunnelPaths).then(() => ({ ready: true })),
      proc.exited.then((code) => ({ ready: false, code })),
    ]);
    if (!outcome.ready) {
      autoSshTunnel = null;
      const code = "code" in outcome ? outcome.code : "unknown";
      throw new Error(`ssh tunnel exited before ready (code ${code})`);
    }

    console.log("[bridge] SSH tunnel ready");
  }

  function cleanupAutoSshTunnel() {
    if (autoSshTunnel) {
      try {
        autoSshTunnel.kill();
      } catch {}
      autoSshTunnel = null;
    }
    for (const path of autoSshTunnelPaths) {
      rmSync(path, { force: true });
    }
  }

  return { startAutoSshTunnel, cleanupAutoSshTunnel };
}
