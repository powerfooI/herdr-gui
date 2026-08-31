import { describe, expect, test } from "bun:test";
import { previewEditorCopyText } from "./previewSelection";

describe("previewEditorCopyText", () => {
  test("returns the selected document slice for selections inside the editor", () => {
    const doc = "line one\nline two\nline three";
    expect(previewEditorCopyText(doc, 0, 17, true)).toBe("line one\nline two");
    expect(previewEditorCopyText(doc, 0, doc.length, true)).toBe(doc);
  });

  test("keeps native copy for empty selections or selections outside the editor", () => {
    expect(previewEditorCopyText("abc", 1, 1, true)).toBeNull();
    expect(previewEditorCopyText("abc", 0, 3, false)).toBeNull();
  });
});
