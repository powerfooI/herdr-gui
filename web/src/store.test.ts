import { describe, expect, test } from "bun:test";
import {
  bindTaskNotificationActivation,
  DEFAULT_NOTICE_AUTO_DISMISS_MS,
  healthMatchesUpdateVersion,
  isTaskNotificationTarget,
  nextRecentPaneIds,
  noticeAutoDismissDelay,
  numberedCreatedTabRename,
  summarizeDirectHookResult,
  worktreeRemovalCompletionNotice,
} from "./store";

describe("task notification activation", () => {
  test("closes the system notification, focuses the window, and dispatches its pane target", () => {
    const calls: string[] = [];
    const targets: Array<{ workspaceId: string; paneId: string }> = [];
    const notification = {
      onclick: null as ((event: Event) => void) | null,
      close: () => calls.push("close"),
    };

    bindTaskNotificationActivation(
      notification,
      { workspaceId: "w1", paneId: "p2" },
      (target) => {
        calls.push("activate");
        targets.push(target);
      },
      () => calls.push("focus"),
    );
    notification.onclick?.(new Event("click"));

    expect(calls).toEqual(["close", "focus", "activate"]);
    expect(targets).toEqual([{ workspaceId: "w1", paneId: "p2" }]);
  });

  test("still dispatches navigation when browser window focus is denied", () => {
    let activated = false;
    const notification = {
      onclick: null as ((event: Event) => void) | null,
      close: () => undefined,
    };

    bindTaskNotificationActivation(
      notification,
      { workspaceId: "w1", paneId: "p2" },
      () => {
        activated = true;
      },
      () => {
        throw new Error("focus denied");
      },
    );

    expect(() => notification.onclick?.(new Event("click"))).not.toThrow();
    expect(activated).toBe(true);
  });

  test("rejects malformed notification targets", () => {
    expect(isTaskNotificationTarget(null)).toBe(false);
    expect(isTaskNotificationTarget({ workspaceId: "w1" })).toBe(false);
    expect(isTaskNotificationTarget({ workspaceId: "", paneId: "p2" })).toBe(
      false,
    );
    expect(isTaskNotificationTarget({ workspaceId: "w1", paneId: "p2" })).toBe(
      true,
    );
  });
});

describe("worktree hook notices", () => {
  test("dismisses successful hook output after a short actionable window", () => {
    expect(
      summarizeDirectHookResult({
        event: "worktree.created",
        status: "succeeded",
        stdout: "configured checkout",
      }),
    ).toMatchObject({
      kind: "success",
      autoDismissMs: 15_000,
    });
  });

  test("leaves failed hooks on the shared default timeout", () => {
    const notice = summarizeDirectHookResult({
      event: "worktree.before_remove",
      status: "failed",
      exit_code: 1,
      stderr: "cleanup failed",
    });
    expect(notice).toMatchObject({ kind: "error" });
    expect(notice?.autoDismissMs).toBeUndefined();
  });
});

describe("notice dismissal policy", () => {
  test("uses 15 seconds for an ordinary toast", () => {
    expect(DEFAULT_NOTICE_AUTO_DISMISS_MS).toBe(15_000);
    expect(noticeAutoDismissDelay({ kind: "info", message: "Saved" })).toBe(
      15_000,
    );
  });

  test("honors explicit durations and keeps loading notices visible", () => {
    expect(
      noticeAutoDismissDelay({
        kind: "success",
        message: "Copied",
        autoDismissMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      noticeAutoDismissDelay({
        kind: "info",
        message: "Working",
        loading: true,
      }),
    ).toBeNull();
  });
});

describe("recent pane history", () => {
  const panes = Array.from({ length: 14 }, (_, index) => ({
    pane_id: `pane-${index + 1}`,
  }));

  test("moves the selected pane to the front without duplicates", () => {
    expect(
      nextRecentPaneIds("pane-2", ["pane-1", "pane-2", "pane-3"], panes),
    ).toEqual(["pane-2", "pane-1", "pane-3"]);
  });

  test("prunes missing panes and keeps the history bounded", () => {
    expect(
      nextRecentPaneIds(
        "pane-14",
        ["missing", ...panes.map((pane) => pane.pane_id)],
        panes,
      ),
    ).toEqual([
      "pane-14",
      "pane-1",
      "pane-2",
      "pane-3",
      "pane-4",
      "pane-5",
      "pane-6",
      "pane-7",
      "pane-8",
      "pane-9",
      "pane-10",
      "pane-11",
    ]);
  });

  test("does not add a pane that is no longer live", () => {
    expect(nextRecentPaneIds("missing", ["pane-1", "missing"], panes)).toEqual([
      "pane-1",
    ]);
  });
});

describe("update restart verification", () => {
  test("matches only the expected running server version", () => {
    expect(healthMatchesUpdateVersion({ version: "0.3.0" }, "0.3.0")).toBe(
      true,
    );
    expect(healthMatchesUpdateVersion({ version: "0.2.9" }, "0.3.0")).toBe(
      false,
    );
    expect(healthMatchesUpdateVersion({ ok: true }, "0.3.0")).toBe(false);
  });
});

describe("numbered tab creation", () => {
  test("uses the authoritative number returned by Herdr", () => {
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t7", number: 7, label: "7" },
      }),
    ).toEqual({ tabId: "w1:t7", label: "Tab 7" });
  });

  test("rejects malformed or unrelated responses", () => {
    expect(numberedCreatedTabRename(null)).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_info",
        tab: { tab_id: "w1:t2", number: 2 },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2" },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2", number: 0 },
      }),
    ).toBeNull();
  });
});

describe("worktree removal notices", () => {
  test("keeps a removed-hook failure visible after stale checkout recovery", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 2,
          preserved_path: "/work/repo.recovered",
        },
        {
          kind: "error",
          message: "Worktree removed hook failed (exit 1)",
          detail: "cleanup failed",
          detailMode: "output",
          detailTitle: "Worktree removed hook output",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed hook failed (exit 1)",
      detail:
        "cleanup failed\nStopped 2 processes still using the checkout.\nStale files were preserved at /work/repo.recovered.",
      detailMode: "output",
      detailTitle: "Worktree removal details",
    });
  });

  test("summarizes recovery when no removed hook ran", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 0,
        },
        null,
      ),
    ).toEqual({
      kind: "success",
      message: "Worktree removed",
      detail:
        "The checkout was already absent; stale Herdr state was reconciled.",
    });
  });

  test("reports a successful Herdr remove with incomplete local cleanup", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          terminated_processes: 0,
          warning: "process 42 survived",
        },
        {
          kind: "success",
          message: "Worktree removed hook completed",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed with cleanup warning",
      detail: "Worktree removed hook completed\nprocess 42 survived",
      detailTitle: "Worktree removal details",
    });
  });
});
