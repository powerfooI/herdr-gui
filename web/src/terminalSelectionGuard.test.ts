import { describe, expect, test } from "bun:test";
import { TerminalSelectionDragGuard } from "./terminalSelectionGuard";

describe("TerminalSelectionDragGuard", () => {
  test("requests a synthetic release when a button-less move follows a lost mouseup", () => {
    const guard = new TerminalSelectionDragGuard();
    guard.mouseDown(0);
    expect(guard.mouseMoveNeedsRelease(1)).toBe(false); // real drag continues
    expect(guard.mouseMoveNeedsRelease(0)).toBe(true); // lost release detected
    expect(guard.mouseMoveNeedsRelease(0)).toBe(false); // reported only once
  });

  test("ignores non-left buttons and moves without a tracked press", () => {
    const guard = new TerminalSelectionDragGuard();
    guard.mouseDown(2);
    expect(guard.mouseMoveNeedsRelease(0)).toBe(false);
    guard.mouseDown(0);
    guard.mouseUp();
    expect(guard.mouseMoveNeedsRelease(0)).toBe(false);
  });

  test("reset clears a tracked gesture", () => {
    const guard = new TerminalSelectionDragGuard();
    guard.mouseDown(0);
    guard.reset();
    expect(guard.mouseMoveNeedsRelease(0)).toBe(false);
  });
});
