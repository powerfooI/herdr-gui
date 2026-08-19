import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createSshProfileRuntimeConfig } from "./ssh-profile-runtime";
import type { SshConnectionProfile } from "./profiles";

const directories: string[] = [];

function profile(): SshConnectionProfile {
  return {
    id: "private-remote",
    label: "Secret Host Label",
    type: "ssh",
    ssh_destination: "operator@dev-box",
    remote_control_socket_path: "/home/operator/.config/herdr/herdr.sock",
    remote_client_socket_path: "/home/operator/.config/herdr/herdr-client.sock",
    auto_connect: false,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SSH profile runtime socket allocation", () => {
  test("allocates short private paths without profile-controlled names", () => {
    const config = createSshProfileRuntimeConfig(profile());
    const directory = config.ownedRuntimeDirectory!;
    directories.push(directory);

    expect(lstatSync(directory).isDirectory()).toBeTrue();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(config.socketPath).toBe(`${directory}/control.sock`);
    expect(config.clientSocketPath).toBe(`${directory}/render.sock`);
    expect(config.socketPath.length).toBeLessThan(100);
    expect(dirname(config.clientSocketPath)).toBe(directory);
    expect(directory).not.toContain(profile().id);
    expect(directory).not.toContain("dev-box");
    expect(config).toMatchObject({
      sshHost: "operator@dev-box",
      remoteSocketPath: profile().remote_control_socket_path,
      remoteClientSocketPath: profile().remote_client_socket_path,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    });
  });

  test("rejects a non-private injected runtime directory", () => {
    expect(() =>
      createSshProfileRuntimeConfig(profile(), {
        createDirectory: () => "/tmp/injected-runtime",
        chmod: () => undefined,
        stat: () => ({ isDirectory: () => true, mode: 0o40755 }),
        removeDirectory: () => undefined,
      }),
    ).toThrow("private directory");
  });
});
