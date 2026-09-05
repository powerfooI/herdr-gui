import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  createReviewAnnotation,
  MAX_QUOTE_LENGTH,
  readReviewAnnotations,
  writeReviewAnnotations,
} from "../annotations";
import {
  FileAnnotationDrag,
  type FileAnnotationRequest,
} from "./fileAnnotationDrag";

function mouse(type: string, line: number, button = 0) {
  return Object.assign(new Event(type, { cancelable: true }), {
    button,
    buttons: type === "mouseup" ? 0 : 1,
    clientX: 12,
    clientY: 100 + (line - 1) * 20 + 10,
  }) as MouseEvent;
}

function setup(doc = "first\nsecond\nthird\n") {
  let state = EditorState.create({ doc });
  const events = new EventTarget();
  const requests: FileAnnotationRequest[] = [];
  const rejections: boolean[] = [];
  const view = {
    get state() {
      return state;
    },
    documentTop: 100,
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    lineBlockAtHeight(height: number) {
      const line = Math.min(
        state.doc.lines,
        Math.max(1, Math.floor(height / 20) + 1),
      );
      return { from: state.doc.line(line).from };
    },
  };
  const drag = new FileAnnotationDrag(
    view as unknown as EditorView,
    (request) => requests.push(request),
    () => rejections.push(true),
    events as Window,
  );
  return { drag, events, requests, view, rejections };
}

describe("file annotation gutter drag", () => {
  test("round-trips the largest accepted range without truncation", () => {
    const quote =
      "x".repeat(9999) + "\n" + "y".repeat(MAX_QUOTE_LENGTH - 10000);
    const { drag, events, requests, rejections } = setup(quote);
    drag.start(1, mouse("mousedown", 1));
    events.dispatchEvent(mouse("mouseup", 2));
    expect(rejections).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].quote).toBe(quote);
    const annotation = createReviewAnnotation({
      source: "file",
      anchor: "line",
      path: "example.ts",
      comment: "Keep this comment.",
      line: requests[0].line,
      endLine: requests[0].endLine,
      quote: requests[0].quote,
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    expect(writeReviewAnnotations(storage, "draft", [annotation])).toBe(true);
    expect(readReviewAnnotations(storage, "draft")).toEqual([annotation]);
  });

  test("rejects oversized ranges, notifies once, and allows a smaller retry", () => {
    const quote = "x".repeat(9999) + "\n" + "y".repeat(MAX_QUOTE_LENGTH - 9999);
    const { drag, events, requests, rejections } = setup(quote);
    expect(quote.length).toBe(MAX_QUOTE_LENGTH + 1);
    drag.start(1, mouse("mousedown", 1));
    events.dispatchEvent(mouse("mouseup", 2));
    events.dispatchEvent(mouse("mouseup", 2));
    expect(requests).toHaveLength(0);
    expect(rejections).toHaveLength(1);
    drag.start(1, mouse("mousedown", 1));
    events.dispatchEvent(mouse("mouseup", 1));
    expect(requests[0].quote).toBe("x".repeat(9999));
    expect(rejections).toHaveLength(1);
  });

  test("selects complete lines and opens the composer only on release", () => {
    const { drag, events, requests, view } = setup();
    drag.start(1, mouse("mousedown", 1));
    events.dispatchEvent(mouse("mousemove", 3));
    expect(requests).toEqual([]);
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("first\nsecond\nthird");
    events.dispatchEvent(mouse("mouseup", 3));
    expect(requests).toEqual([
      { line: 1, endLine: 3, quote: "first\nsecond\nthird", x: 18, y: 158 },
    ]);
  });

  test("normalizes upward drags and keeps blank ending lines", () => {
    const { drag, events, requests } = setup();
    drag.start(4, mouse("mousedown", 4));
    events.dispatchEvent(mouse("mouseup", 2));
    expect(requests[0]).toMatchObject({
      line: 2,
      endLine: 4,
      quote: "second\nthird\n",
    });
  });

  test("preserves single-click annotations and ignores right clicks", () => {
    const { drag, events, requests } = setup();
    expect(drag.start(2, mouse("mousedown", 2, 2))).toBe(false);
    drag.start(2, mouse("mousedown", 2));
    events.dispatchEvent(mouse("mouseup", 2));
    expect(requests[0]).toMatchObject({ line: 2, quote: "second" });
    expect(requests[0].endLine).toBeUndefined();
    events.dispatchEvent(mouse("mouseup", 3));
    expect(requests).toHaveLength(1);
  });

  test("cancels on Escape, window blur, or editor teardown", () => {
    for (const reason of ["Escape", "blur", "destroy"]) {
      const { drag, events, requests } = setup();
      drag.start(1, mouse("mousedown", 1));
      if (reason === "destroy") drag.destroy();
      else if (reason === "blur") events.dispatchEvent(new Event("blur"));
      else
        events.dispatchEvent(
          Object.assign(new Event("keydown"), { key: "Escape" }),
        );
      events.dispatchEvent(mouse("mouseup", 3));
      expect(requests).toEqual([]);
    }
  });

  test("clamps releases beyond the document to its first and last lines", () => {
    const { drag, events, requests } = setup();
    drag.start(2, mouse("mousedown", 2));
    events.dispatchEvent(mouse("mouseup", 99));
    expect(requests[0]).toMatchObject({ line: 2, endLine: 4 });
    drag.start(2, mouse("mousedown", 2));
    events.dispatchEvent(mouse("mouseup", -99));
    expect(requests[1]).toMatchObject({ line: 1, endLine: 2 });
  });
});
