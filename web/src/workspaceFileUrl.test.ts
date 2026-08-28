import { describe, expect, test } from "bun:test";
import {
  resolveWorkspaceMarkdownImagePath,
  resolveWorkspaceMarkdownImageUrl,
  workspaceFileUrl,
} from "./workspaceFileUrl";

const client = {
  connectionId: "remote dev",
  serverRuntimeGeneration: 7,
};

describe("workspace file URLs", () => {
  test("builds generation-bound inline resource URLs", () => {
    expect(workspaceFileUrl(client, "workspace 1", "docs/a b.pdf")).toBe(
      "/api/connections/remote%20dev/file/download?connection_generation=7&workspace_id=workspace+1&path=docs%2Fa+b.pdf",
    );
    expect(
      workspaceFileUrl(client, "workspace 1", "docs/a b.pdf", {
        inline: true,
        revision: 3,
      }),
    ).toEndWith("&inline=1&resource_revision=3");
  });

  test("resolves Markdown images relative to the document", () => {
    expect(
      resolveWorkspaceMarkdownImagePath(
        "../assets/demo%20image.png",
        "docs/guide/readme.md",
      ),
    ).toBe("docs/assets/demo image.png");
    expect(
      resolveWorkspaceMarkdownImagePath("/assets/logo.png", "docs/readme.md"),
    ).toBe("assets/logo.png");
    expect(
      resolveWorkspaceMarkdownImagePath(
        "../../../secret.png",
        "docs/readme.md",
      ),
    ).toBeNull();
  });

  test("keeps remote images and maps local images to the workspace endpoint", () => {
    expect(
      resolveWorkspaceMarkdownImageUrl(
        "https://example.com/image.png",
        "README.md",
        client,
        "w1",
      ),
    ).toBe("https://example.com/image.png");
    expect(
      resolveWorkspaceMarkdownImageUrl(
        "images/screenshot.png",
        "docs/README.md",
        client,
        "w1",
        4,
      ),
    ).toContain(
      "path=docs%2Fimages%2Fscreenshot.png&inline=1&resource_revision=4",
    );
  });
});
