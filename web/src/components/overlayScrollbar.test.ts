import { describe, expect, test } from "bun:test";
import {
  calculateOverlayThumb,
  overlayScrollbarExcludedElement,
} from "./overlayScrollbar";

describe("overlay scrollbar exclusions", () => {
  test("excludes dialogs, popovers, menus, and mobile shortcut panels", () => {
    for (const match of [
      ".modal-backdrop",
      ".popover-content",
      ".config-dropdown",
      ".context-menu",
      ".pane-jump-popover",
      ".agent-session-export-menu",
      ".terminal-mobile-keys-panel",
      "[role=dialog]",
      "[role=menu]",
      "[role=listbox]",
    ]) {
      expect(
        overlayScrollbarExcludedElement({
          closest: () => ({ match }) as unknown as Element,
        }),
      ).toBe(true);
    }
  });

  test("keeps ordinary application scroll regions eligible", () => {
    expect(
      overlayScrollbarExcludedElement({ closest: () => null }),
    ).toBe(false);
  });
});

describe("overlay scrollbar geometry", () => {
  test("does not render when content fits", () => {
    expect(
      calculateOverlayThumb({
        viewportStart: 10,
        viewportSize: 200,
        clientSize: 200,
        scrollSize: 200,
        scrollOffset: 0,
      }),
    ).toBeNull();
  });

  test("positions a proportional thumb along the track", () => {
    const thumb = calculateOverlayThumb({
      viewportStart: 10,
      viewportSize: 206,
      clientSize: 200,
      scrollSize: 800,
      scrollOffset: 300,
      inset: 3,
      minSize: 28,
    });

    expect(thumb).not.toBeNull();
    expect(thumb!.trackLength).toBe(200);
    expect(thumb!.size).toBe(50);
    expect(thumb!.maxScroll).toBe(600);
    expect(thumb!.start).toBe(88);
  });

  test("clamps small thumbs and out-of-range scroll offsets", () => {
    const thumb = calculateOverlayThumb({
      viewportStart: 0,
      viewportSize: 100,
      clientSize: 100,
      scrollSize: 10_000,
      scrollOffset: 20_000,
      inset: 2,
      minSize: 24,
    });

    expect(thumb).not.toBeNull();
    expect(thumb!.size).toBe(24);
    expect(thumb!.start).toBe(74);
  });
});
