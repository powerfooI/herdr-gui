import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { validateSshDestination } from "../bridge/ssh-command";
import { defaultAuthTokenPath, loadOrCreateAuthToken } from "./auth-token";

type CliArgs = Partial<{
  host: string;
  port: string;
  password: string;
  "socket-path": string;
  "client-socket-path": string;
  "ssh-host": string;
  session: string;
  "public-dir": string;
  open: boolean;
  help: boolean;
  version: boolean;
}>;

export type ServerConfig = {
  appVersion: string;
  host: string;
  port: number;
  password: string;
  authRequired: boolean;
  generatedAuthToken?: string;
  generatedAuthTokenPath?: string;
  socketPath: string;
  clientSocketPath: string;
  publicDir: string;
  sshHost?: string;
  session?: string;
  openBrowserRequested: boolean;
  hasExplicitSocketPath: boolean;
  hasExplicitClientSocketPath: boolean;
};

const cliOptions = {
  host: { type: "string" },
  port: { type: "string" },
  password: { type: "string" },
  "socket-path": { type: "string" },
  "client-socket-path": { type: "string" },
  "ssh-host": { type: "string" },
  session: { type: "string" },
  "public-dir": { type: "string" },
  open: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean", short: "V" },
} as const;

export function loadServerConfig(appVersion: string): ServerConfig {
  let args: CliArgs;
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: cliOptions,
      strict: true,
      allowPositionals: false,
    }).values as CliArgs;
  } catch (e) {
    console.error(`[bridge] ${(e as Error).message}`);
    console.error("Run `herdr-gui --help` for usage.");
    process.exit(2);
  }

  if (args.help) {
    console.log(`herdr-gui — web client for Herdr

Usage: herdr-gui [options]
       herdr-gui service <action>

Service actions:
  install [--force]           install and start a systemd/launchd user service
  status                      show service status
  restart                     restart the managed service
  reload                      reload its definition and restart the service
  uninstall                   stop and remove the service definition
  Run \`herdr-gui service --help\` for service details.

Options (flags override env vars):
  --host <addr>              listen address        (env HOST,            default 127.0.0.1)
  --port <n>                 listen port           (env PORT,            default 8787)
  --password <pw>            fixed login password  (env HERDR_GUI_PASSWORD; otherwise a token is generated)
  --socket-path <path>       control socket        (env HERDR_SOCKET_PATH)
  --client-socket-path <p>   render socket         (env HERDR_CLIENT_SOCKET_PATH)
  --ssh-host <user@host>     remote Herdr over SSH (env HERDR_SSH_HOST)
  --session <name>           named herdr session   (env HERDR_SESSION)
  --public-dir <path>        static assets dir     (env PUBLIC_DIR,      default: embedded)
  --open                     open browser on start (env OPEN_BROWSER=1)
  -V, --version              show version
  --help                     show this help
`);
    process.exit(0);
  }

  if (args.version) {
    console.log(`herdr-gui ${appVersion}`);
    process.exit(0);
  }

  const host = String(args.host ?? process.env.HOST ?? "127.0.0.1");
  const port = Number(args.port ?? process.env.PORT ?? 8787);
  const configuredPassword = String(
    args.password ?? process.env.HERDR_GUI_PASSWORD ?? "",
  );
  const authRequired = !isLocalHost(host);
  const generatedAuthTokenPath =
    authRequired && !configuredPassword ? defaultAuthTokenPath() : undefined;
  let generatedAuthToken: string | undefined;
  try {
    generatedAuthToken = generatedAuthTokenPath
      ? loadOrCreateAuthToken(generatedAuthTokenPath)
      : undefined;
  } catch (cause) {
    console.error(
      `[bridge] FATAL: could not load the generated auth token: ${(cause as Error).message}`,
    );
    process.exit(1);
  }
  const password = configuredPassword || generatedAuthToken || "";

  const sshHostValue =
    (typeof args["ssh-host"] === "string" && args["ssh-host"]) ||
    process.env.HERDR_SSH_HOST ||
    undefined;
  let sshHost: string | undefined;
  try {
    sshHost = sshHostValue ? validateSshDestination(sshHostValue) : undefined;
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const session =
    (typeof args.session === "string" && args.session) ||
    process.env.HERDR_SESSION ||
    undefined;
  const hasExplicitSocketPath =
    typeof args["socket-path"] === "string" || !!process.env.HERDR_SOCKET_PATH;
  const hasExplicitClientSocketPath =
    typeof args["client-socket-path"] === "string" ||
    !!process.env.HERDR_CLIENT_SOCKET_PATH;

  const socketPath = resolveSocketPath(args, sshHost, session);
  const clientSocketPath = resolveClientSocketPath(args, sshHost, session);

  return {
    appVersion,
    host,
    port,
    password,
    authRequired,
    generatedAuthToken,
    generatedAuthTokenPath,
    socketPath,
    clientSocketPath,
    publicDir: resolvePublicDir(args),
    sshHost,
    session,
    openBrowserRequested:
      args.open === true || process.env.OPEN_BROWSER === "1",
    hasExplicitSocketPath,
    hasExplicitClientSocketPath,
  };
}

function isLocalHost(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function remoteTunnelLocalPath(
  host: string | undefined,
  session: string | undefined,
  kind: "control" | "client",
): string {
  const hostKey = host ?? "remote";
  const sessionKey = session ?? "default";
  const key = createHash("sha1")
    .update(`${hostKey}\0${sessionKey}\0${kind}`)
    .digest("hex")
    .slice(0, 12);
  return `/tmp/herdr-gui-${key}-${kind}.sock`;
}

function resolveSocketPath(
  args: CliArgs,
  sshHost: string | undefined,
  session: string | undefined,
): string {
  const fromFlag = args["socket-path"];
  if (typeof fromFlag === "string") return fromFlag;
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (sshHost) return remoteTunnelLocalPath(sshHost, session, "control");
  const base = resolve(homedir(), ".config", "herdr");
  if (session) return resolve(base, "sessions", session, "herdr.sock");
  return resolve(base, "herdr.sock");
}

function resolveClientSocketPath(
  args: CliArgs,
  sshHost: string | undefined,
  session: string | undefined,
): string {
  const fromFlag = args["client-socket-path"];
  if (typeof fromFlag === "string") return fromFlag;
  if (process.env.HERDR_CLIENT_SOCKET_PATH)
    return process.env.HERDR_CLIENT_SOCKET_PATH;
  if (sshHost) return remoteTunnelLocalPath(sshHost, session, "client");
  const base = resolve(homedir(), ".config", "herdr");
  if (session) return resolve(base, "sessions", session, "herdr-client.sock");
  return resolve(base, "herdr-client.sock");
}

function resolvePublicDir(args: CliArgs): string {
  const fromFlag = args["public-dir"];
  if (typeof fromFlag === "string") return fromFlag;
  if (process.env.PUBLIC_DIR) return process.env.PUBLIC_DIR;
  const exeDir = dirname(process.execPath);
  const nextToExe = join(exeDir, "public");
  if (existsSync(nextToExe)) return nextToExe;
  return join(process.cwd(), "public");
}

export function getLanIPs(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .filter(({ family, internal }) => family === "IPv4" && !internal)
    .map(({ address }) => address);
}

export function isAnyHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function formatUrlHost(host: string): string {
  if (host === "127.0.0.1" || host === "::1") return "localhost";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function browserUrlFor(host: string, port: number): string {
  const browserHost = isAnyHost(host) ? "localhost" : formatUrlHost(host);
  return `http://${browserHost}:${port}`;
}

export function withLoginToken(url: string, token?: string): string {
  if (!token) return url;
  const result = new URL(url);
  result.searchParams.set("token", token);
  return result.toString();
}

export function openBrowser(config: ServerConfig, url: string) {
  if (!config.openBrowserRequested) return;
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const openerArgs =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([opener, ...openerArgs], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    console.error(`[bridge] failed to open browser: ${(e as Error).message}`);
  }
}
