import { describe, expect, test } from "bun:test";
import { browserTransportPresentation } from "./browserTransport";

describe("browser transport presentation", () => {
  test("offers pause controls and counts only other connected browsers", () => {
    expect(browserTransportPresentation(false, "connected", 3)).toEqual({
      label: "Browser connected to bridge",
      clientCount: 3,
      pauseOthersLabel: "Pause other browsers (2)",
      needsResume: false,
      toggleLabel: "Pause browser sync",
    });
  });

  test("labels a single other browser and hides the action when alone", () => {
    expect(
      browserTransportPresentation(false, "connected", 2).pauseOthersLabel,
    ).toBe("Pause other browser");
    expect(
      browserTransportPresentation(false, "connected", 1).pauseOthersLabel,
    ).toBeNull();
  });

  test("offers resume while paused without exposing a stale client count", () => {
    expect(browserTransportPresentation(true, "connected", 3)).toEqual({
      label: "Browser sync paused",
      clientCount: null,
      pauseOthersLabel: null,
      needsResume: true,
      toggleLabel: "Resume browser sync",
    });
  });

  test("offers reconnect after browser transport loss", () => {
    expect(browserTransportPresentation(false, "disconnected", 3)).toEqual({
      label: "Browser disconnected from bridge",
      clientCount: null,
      pauseOthersLabel: null,
      needsResume: true,
      toggleLabel: "Reconnect browser",
    });
  });

  test("keeps connecting transport pausable", () => {
    expect(browserTransportPresentation(false, "connecting", null)).toEqual({
      label: "Browser connecting to bridge",
      clientCount: null,
      pauseOthersLabel: null,
      needsResume: false,
      toggleLabel: "Pause browser sync",
    });
  });
});
