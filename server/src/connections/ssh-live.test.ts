import { expect, test } from "bun:test";
import { createSshTunnelManager } from "../bridge/ssh-tunnel";
import { runProcess } from "../utils/process-utils";
import { testConnectionSockets } from "./profile-service";
import {
  validateSshConnectionProfile,
  type SshConnectionProfile,
} from "./profiles";
import { createSshProfileRuntimeConfig } from "./ssh-profile-runtime";

const liveEnabled = process.env.HERDR_GUI_LIVE_SSH === "1";
const liveTest = liveEnabled ? test : test.skip;

liveTest("live OpenSSH forwards existing remote Herdr sockets", async () => {
  const profile = validateSshConnectionProfile({
    id: "live-ssh-smoke",
    label: "Live SSH smoke",
    type: "ssh",
    ssh_destination: process.env.HERDR_GUI_LIVE_SSH_HOST,
    remote_control_socket_path: process.env.HERDR_GUI_LIVE_SSH_CONTROL_SOCKET,
    remote_client_socket_path: process.env.HERDR_GUI_LIVE_SSH_CLIENT_SOCKET,
    auto_connect: false,
  }) as SshConnectionProfile;
  const config = createSshProfileRuntimeConfig(profile);
  const tunnel = createSshTunnelManager({
    connectionId: profile.id,
    config,
    runProcess,
  });
  try {
    await tunnel.startAutoSshTunnel();
    await expect(
      testConnectionSockets(config.socketPath, config.clientSocketPath),
    ).resolves.toMatchObject({ ok: true });
  } finally {
    await tunnel.cleanupAutoSshTunnel();
  }
});
