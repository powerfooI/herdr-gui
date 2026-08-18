import { describe, expect, test } from "bun:test";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES } from "./file-constants";
import {
  decodePreviewBuffer,
  imageMimeForPath,
  previewLimitForPath,
  trimIncompleteUtf8Tail,
} from "./preview";

describe("workspace preview helpers", () => {
  test("detects supported image MIME types", () => {
    expect(imageMimeForPath("image.PNG")).toBe("image/png");
    expect(imageMimeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeForPath("archive.tar")).toBeNull();
  });

  test("chooses larger limits only for previewable images", () => {
    expect(previewLimitForPath("photo.png", PREVIEW_IMAGE_MAX_BYTES)).toBe(
      PREVIEW_IMAGE_MAX_BYTES,
    );
    expect(previewLimitForPath("photo.png", PREVIEW_IMAGE_MAX_BYTES + 1)).toBe(
      PREVIEW_MAX_BYTES,
    );
    expect(previewLimitForPath("notes.txt", 10)).toBe(PREVIEW_MAX_BYTES);
  });

  test("decodes text previews and flags binary data", () => {
    expect(
      decodePreviewBuffer(Buffer.from("hello"), false, "README.md"),
    ).toEqual({
      text: "hello",
      binary: false,
    });
    expect(
      decodePreviewBuffer(Buffer.from([0, 1, 2]), false, "data.bin"),
    ).toEqual({
      text: null,
      binary: true,
      mime_type: undefined,
    });
  });

  test("returns data URLs for complete image previews", () => {
    const preview = decodePreviewBuffer(
      Buffer.from("png-data"),
      false,
      "a.png",
    );
    expect(preview.binary).toBe(true);
    expect(preview.mime_type).toBe("image/png");
    expect(preview.image_data_url).toBe("data:image/png;base64,cG5nLWRhdGE=");
  });

  test("trims incomplete UTF-8 tails for truncated text", () => {
    const buffer = Buffer.from("hello 😀");
    const trimmed = trimIncompleteUtf8Tail(
      buffer.subarray(0, buffer.length - 1),
    );
    expect(trimmed.toString("utf8")).toBe("hello ");

    const preview = decodePreviewBuffer(
      buffer.subarray(0, buffer.length - 1),
      true,
      "README.md",
    );
    expect(preview).toEqual({ text: "hello ", binary: false });
  });
});
