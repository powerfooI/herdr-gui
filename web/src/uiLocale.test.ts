import { describe, expect, test } from "bun:test";
import { formatUiRelativeTime, UI_LOCALE } from "./uiLocale";

describe("UI locale", () => {
  test("keeps generated relative-time labels in English", () => {
    expect(UI_LOCALE).toBe("en-US");
    expect(formatUiRelativeTime(0, "second")).toBe("now");
    expect(formatUiRelativeTime(-2, "minute")).toBe("2 minutes ago");
    expect(formatUiRelativeTime(1, "day")).toBe("tomorrow");
  });
});
