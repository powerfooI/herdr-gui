import { describe, expect, test } from "bun:test";
import { dialogKeyAction } from "./dialogKeyboard";

describe("dialog keyboard containment", () => {
  test("leaves Enter to the focused button inside a confirmation dialog", () => {
    expect(dialogKeyAction("Enter", true)).toBe("native");
  });

  test("closes on Escape and contains keys arriving from outside", () => {
    expect(dialogKeyAction("Escape", true)).toBe("close");
    expect(dialogKeyAction("Enter", false)).toBe("contain");
  });
});
