import { expect, test } from "bun:test";
import {
  mergeAgentHistory,
  selectHistoryEntries,
  ALL_HISTORY_FILTERS,
  type AgentHistoryResponse,
  type HistoryEntry,
} from "./agentHistory";

const entry = (id: string, text = id): HistoryEntry => ({
  id,
  kind: "message",
  role: "user",
  text,
  sent_at: "2026-01-01T00:00:00Z",
});
function response(
  entries: HistoryEntry[],
  revision = 1,
  epoch = "a",
): AgentHistoryResponse {
  return {
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch, revision },
    window_limit: 200,
    entries,
    agent: "pi",
    pane_id: "p",
    workspace_id: "w",
    tab_id: "t",
    updated_at: "",
    path: "/tmp/a",
  };
}

test("merges updates, removals and explicit order without retaining full transport payloads", () => {
  const first = mergeAgentHistory(
    null,
    response([entry("1"), entry("2")]),
    null,
  )!;
  const next = mergeAgentHistory(
    first,
    {
      ...response([]),
      mode: "delta",
      base_revision: 1,
      cursor: { epoch: "a", revision: 2 },
      removed: ["1"],
      upserts: [entry("2", "edited"), entry("3")],
      order: ["3", "2"],
    },
    first.cursor,
  )!;
  expect(next.messages.map((item) => item.text)).toEqual(["3", "edited"]);
  expect(next).not.toHaveProperty("upserts");
  expect(next).not.toHaveProperty("entries");
  const unchanged = mergeAgentHistory(
    next,
    {
      ...response([]),
      mode: "delta",
      base_revision: 2,
      cursor: next.cursor,
      upserts: [],
      removed: [],
    },
    next.cursor,
  )!;
  expect(unchanged.messages).toEqual(next.messages);
});

test("rejects stale, duplicate and out-of-order responses including old epoch resets", () => {
  const first = mergeAgentHistory(null, response([entry("1")]), null)!;
  const second = mergeAgentHistory(
    first,
    response([entry("2")], 2),
    first.cursor,
  )!;
  expect(
    mergeAgentHistory(second, response([entry("stale")]), first.cursor),
  ).toBe(second);
  expect(
    mergeAgentHistory(second, response([entry("duplicate")], 2), first.cursor),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      response([entry("old reset")], 1, "old"),
      first.cursor,
    ),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      response([entry("regression")], 1),
      second.cursor,
    ),
  ).toBe(second);
  expect(
    mergeAgentHistory(
      second,
      {
        ...response([]),
        mode: "delta",
        base_revision: 3,
        cursor: { epoch: "a", revision: 4 },
        upserts: [],
        removed: [],
      },
      second.cursor,
    ),
  ).toBe(second);
  const reset = mergeAgentHistory(
    second,
    response([], 1, "new"),
    second.cursor,
  )!;
  expect(reset.cursor.epoch).toBe("new");
  expect(reset.messages).toEqual([]);
  expect(
    mergeAgentHistory(null, response([entry("previous pane")]), second.cursor),
  ).toBeNull();
});

test("filtering leaves hidden entries synchronized across delta updates and removals", () => {
  const tool: HistoryEntry = {
    ...entry("tool", "old output"),
    role: "tool",
    kind: "tool_result",
  };
  const first = mergeAgentHistory(null, response([entry("user"), tool]), null)!;
  const filters = { user: true, agent: false, tool: false };
  expect(selectHistoryEntries(first.messages, filters).visible).toEqual([
    entry("user"),
  ]);
  const next = mergeAgentHistory(
    first,
    {
      ...response([]),
      mode: "delta",
      base_revision: 1,
      cursor: { epoch: "a", revision: 2 },
      removed: ["user"],
      upserts: [{ ...tool, text: "updated output" }, entry("new")],
      order: ["tool", "new"],
    },
    first.cursor,
  )!;
  expect(selectHistoryEntries(next.messages, filters).visible).toEqual([
    entry("new"),
  ]);
  expect(
    selectHistoryEntries(next.messages, ALL_HISTORY_FILTERS).visible.map(
      (item) => item.text,
    ),
  ).toEqual(["updated output", "new"]);
  expect(next.cursor).toEqual({ epoch: "a", revision: 2 });
});

test("bounds snapshots and rejects malformed delta ordering", () => {
  const first = mergeAgentHistory(
    null,
    response(Array.from({ length: 205 }, (_, index) => entry(String(index)))),
    null,
  )!;
  expect(first.messages).toHaveLength(200);
  expect(first.messages[0].id).toBe("5");
  expect(
    mergeAgentHistory(
      first,
      {
        ...response([]),
        mode: "delta",
        base_revision: 1,
        cursor: { epoch: "a", revision: 2 },
        upserts: [],
        removed: [],
        order: ["unknown"],
      },
      first.cursor,
    ),
  ).toBe(first);
});
