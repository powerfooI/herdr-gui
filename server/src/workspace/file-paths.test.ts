import { describe, expect, test } from "bun:test";
import {
  downloadContentDisposition,
  inlineContentDisposition,
  relativeExplorerPath,
  sanitizeExplorerPath,
  sanitizePreviewPath,
  sanitizeUploadFilename,
} from "./file-paths";

describe("workspace file path helpers", () => {
  test("sanitizes explorer paths relative to the checkout", () => {
    expect(sanitizeExplorerPath("/src/components")).toBe("src/components");
    expect(sanitizeExplorerPath("src\\components\\App.tsx")).toBe(
      "src/components/App.tsx",
    );
    expect(sanitizeExplorerPath("")).toBe("");
  });

  test("rejects traversal and NUL bytes in explorer paths", () => {
    expect(() => sanitizeExplorerPath("../secret")).toThrow(
      "invalid file explorer path",
    );
    expect(() => sanitizeExplorerPath("src/\0secret")).toThrow(
      "invalid file explorer path",
    );
  });

  test("allows preview paths inside and outside the checkout", () => {
    expect(sanitizePreviewPath("src/App.tsx")).toBe("src/App.tsx");
    expect(sanitizePreviewPath("/tmp/screenshot.png")).toBe(
      "/tmp/screenshot.png",
    );
  });

  test("rejects unsafe preview and upload paths", () => {
    expect(() => sanitizePreviewPath("/tmp/../secret")).toThrow(
      "invalid file preview path",
    );
    expect(() => sanitizeUploadFilename("nested/file.txt")).toThrow(
      "invalid upload filename",
    );
    expect(() => sanitizeUploadFilename("")).toThrow("invalid upload filename");
  });

  test("builds relative explorer paths and safe download headers", () => {
    expect(relativeExplorerPath("", "README.md")).toBe("README.md");
    expect(relativeExplorerPath("docs", "README.md")).toBe("docs/README.md");

    const header = downloadContentDisposition("测试 file.txt");
    expect(header).toContain('filename="__ file.txt"');
    expect(header).toContain("filename*=UTF-8''%E6%B5%8B%E8%AF%95%20file.txt");
    expect(inlineContentDisposition("guide.pdf")).toBe(
      "inline; filename=\"guide.pdf\"; filename*=UTF-8''guide.pdf",
    );
  });
});
