import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { createUpdateHandlers, resolveUpdateTarget } from "./update";

function createUpdateFixture({ badDigest = false } = {}) {
  const target = resolveUpdateTarget(process.platform, process.arch);
  if (!target) {
    throw new Error(
      `unsupported test platform: ${process.platform}-${process.arch}`,
    );
  }

  const root = mkdtempSync(join(tmpdir(), "herdr-gui-update-test-"));
  const assets = join(root, "assets");
  const packagePath = join(assets, target.packageDir);
  const installPath = join(root, "installed", "herdr-gui");
  mkdirSync(packagePath, { recursive: true });
  mkdirSync(join(root, "installed"), { recursive: true });
  writeFileSync(installPath, "old executable\n", { mode: 0o755 });
  writeFileSync(
    join(packagePath, "herdr-gui"),
    '#!/bin/sh\n[ "${1:-}" = "--version" ] && { echo "herdr-gui 9.8.7"; exit 0; }\nexit 1\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(packagePath, "VERSION"),
    `herdr-gui 9.8.7 ${target.platform}\n`,
  );

  const archive = join(assets, target.archiveName);
  const packaged = Bun.spawnSync(
    ["tar", "-C", assets, "-cJf", archive, target.packageDir],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stderr: "pipe",
    },
  );
  if (packaged.exitCode !== 0) {
    throw new Error(packaged.stderr.toString());
  }
  const archiveDigest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync(
    join(assets, target.manifestName),
    JSON.stringify({
      schema: 1,
      name: "herdr-gui",
      version: "9.8.7",
      platform: target.platform,
      archive: target.archiveName,
      sha256: badDigest ? "0".repeat(64) : archiveDigest,
    }),
  );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const name = basename(new URL(req.url).pathname);
      const file = Bun.file(join(assets, name));
      return (await file.exists())
        ? new Response(file)
        : new Response("not found", { status: 404 });
    },
  });

  return {
    root,
    installPath,
    baseUrl: `http://127.0.0.1:${server.port}`,
    cleanup() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function installRequest() {
  return new Request("http://localhost/api/update/install", {
    method: "POST",
    headers: { "x-herdr-gui-update": "1" },
  });
}

describe("automatic update installation", () => {
  test("verifies, narrows, and atomically replaces the running executable", async () => {
    const fixture = createUpdateFixture();
    let exitScheduled = false;
    try {
      const handlers = createUpdateHandlers({
        appVersion: "9.8.6",
        runProcessWithCodeTimeout,
        shQuote,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          execPath: fixture.installPath,
          argv: [fixture.installPath],
        },
        environment: {
          HERDR_GUI_UPDATE_BASE_URL: fixture.baseUrl,
          HERDR_GUI_RESTART_SUPERVISOR: "1",
        },
        scheduleProcessExit: () => {
          exitScheduled = true;
        },
      });

      const response = await handlers.handleUpdateInstall(installRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        installed: true,
        installed_version: "9.8.7",
        target_path: fixture.installPath,
        backup_path: `${fixture.installPath}.previous`,
      });
      expect(exitScheduled).toBe(true);
      expect(readFileSync(`${fixture.installPath}.previous`, "utf8")).toBe(
        "old executable\n",
      );
      expect(
        Bun.spawnSync([fixture.installPath, "--version"], {
          stdout: "pipe",
        })
          .stdout.toString()
          .trim(),
      ).toBe("herdr-gui 9.8.7");
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps the old executable when the archive digest does not match", async () => {
    const fixture = createUpdateFixture({ badDigest: true });
    let exitScheduled = false;
    try {
      const handlers = createUpdateHandlers({
        appVersion: "9.8.6",
        runProcessWithCodeTimeout,
        shQuote,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          execPath: fixture.installPath,
          argv: [fixture.installPath],
        },
        environment: {
          HERDR_GUI_UPDATE_BASE_URL: fixture.baseUrl,
          HERDR_GUI_RESTART_SUPERVISOR: "1",
        },
        scheduleProcessExit: () => {
          exitScheduled = true;
        },
      });

      const response = await handlers.handleUpdateInstall(installRequest());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: "downloaded archive checksum does not match update manifest",
      });
      expect(exitScheduled).toBe(false);
      expect(readFileSync(fixture.installPath, "utf8")).toBe(
        "old executable\n",
      );
      expect(existsSync(`${fixture.installPath}.previous`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
