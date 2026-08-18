import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const AUTH_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function defaultAuthTokenPath(homeDir = homedir()): string {
  return join(homeDir, ".config", "herdr-gui", "auth-token");
}

function readAuthToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`generated auth token path is not a regular file: ${path}`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!AUTH_TOKEN_PATTERN.test(token)) {
    throw new Error(
      `invalid generated auth token in ${path}; remove the file to regenerate it`,
    );
  }
  chmodSync(path, 0o600);
  return token;
}

export function loadOrCreateAuthToken(path = defaultAuthTokenPath()): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${token}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return token;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return readAuthToken(path);
  }
}
