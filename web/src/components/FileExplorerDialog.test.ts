import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "../api";
import type { FilePreview } from "../types";
import {
  explorerCacheKey,
  filePreviewCacheKey,
  requestFilePreview,
} from "./FileExplorerDialog";

function preview(label: string): FilePreview {
  return {
    workspace_id: "same-workspace",
    checkout_path: "/tmp",
    root: "/tmp",
    path: `${label}.txt`,
    size: label.length,
    mtime_ms: 1,
    text: label,
    binary: false,
    truncated: false,
  };
}

function client(
  connectionId: string,
  generation: number,
  call: ConnectionClient["call"],
  isCurrent: () => boolean = () => true,
): ConnectionClient {
  return {
    connectionId,
    generation,
    serverRuntimeGeneration: generation,
    call,
    isCurrent,
    acceptsServerGeneration: (value) => value === generation,
  };
}

describe("connection-scoped file previews", () => {
  test("isolates colliding workspace paths by connection generation", async () => {
    const alpha = client("alpha", 1, async () => preview("alpha"));
    const beta = client("beta", 1, async () => preview("beta"));

    expect(explorerCacheKey(alpha, "same", false)).not.toBe(
      explorerCacheKey(beta, "same", false),
    );
    expect(filePreviewCacheKey(alpha, "same", "same.txt")).not.toBe(
      filePreviewCacheKey(beta, "same", "same.txt"),
    );
    await expect(
      requestFilePreview("same", "same.txt", { client: alpha }),
    ).resolves.toMatchObject({ text: "alpha" });
    await expect(
      requestFilePreview("same", "same.txt", { client: beta }),
    ).resolves.toMatchObject({ text: "beta" });
  });

  test("does not cache a result after its client becomes stale", async () => {
    let current = true;
    let calls = 0;
    let resolveFirst!: (value: FilePreview) => void;
    const scopedClient = client(
      "stale-preview",
      7,
      () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<FilePreview>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(preview("fresh"));
      },
      () => current,
    );

    const stale = requestFilePreview("same", "same.txt", {
      client: scopedClient,
    });
    current = false;
    resolveFirst(preview("stale"));
    await expect(stale).rejects.toThrow("connection changed");

    current = true;
    await expect(
      requestFilePreview("same", "same.txt", { client: scopedClient }),
    ).resolves.toMatchObject({ text: "fresh" });
    expect(calls).toBe(2);
  });
});
