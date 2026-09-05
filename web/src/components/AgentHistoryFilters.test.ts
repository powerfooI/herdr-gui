import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentHistoryFilters } from "./AgentHistoryFilters";
import {
  ALL_HISTORY_FILTERS,
  HISTORY_CATEGORIES,
  historyEntryCategory,
  selectHistoryEntries,
  type HistoryEntry,
} from "./agentHistory";

const entries: HistoryEntry[] = [
  { id: "u", kind: "message", role: "user", text: "Run", sent_at: "" },
  { id: "a", kind: "message", role: "assistant", text: "OK", sent_at: "" },
  { id: "c", kind: "tool_call", role: "tool", text: "{}", sent_at: "" },
  { id: "r", kind: "tool_result", role: "tool", text: "Done", sent_at: "" },
  {
    id: "t",
    kind: "tool_result",
    role: "tool",
    is_error: true,
    text: "Tool failed",
    sent_at: "",
  },
  {
    id: "e",
    kind: "error",
    role: "assistant",
    text: "Agent failed",
    sent_at: "",
  },
];

test.each(Array.from({ length: 8 }, (_, mask) => mask))(
  "message filter combination %i preserves order and unfiltered counts",
  (mask) => {
    const filters = {
      user: Boolean(mask & 1),
      agent: Boolean(mask & 2),
      tool: Boolean(mask & 4),
    };
    const before = structuredClone(entries);
    const { visible, counts } = selectHistoryEntries(entries, filters);
    const expected = [
      ...(filters.user ? ["u"] : []),
      ...(filters.agent ? ["a"] : []),
      ...(filters.tool ? ["c", "r", "t"] : []),
      ...(filters.agent ? ["e"] : []),
    ];
    expect(visible.map((entry) => entry.id)).toEqual(expected);
    expect(counts).toEqual({ user: 1, agent: 2, tool: 3 });
    expect(entries).toEqual(before);
    for (const entry of visible) expect(entries).toContain(entry);
  },
);

test("agent errors belong to Agent; tool calls, outputs and errors belong to Tool", () => {
  expect(entries.map(historyEntryCategory)).toEqual([
    "user",
    "agent",
    "tool",
    "tool",
    "tool",
    "agent",
  ]);
  expect(selectHistoryEntries([], ALL_HISTORY_FILTERS)).toEqual({
    visible: [],
    counts: { user: 0, agent: 0, tool: 0 },
  });
});

test("filter buttons expose independent pressed states, labels and counts", () => {
  const html = renderToStaticMarkup(
    createElement(AgentHistoryFilters, {
      filters: { user: true, agent: false, tool: true },
      counts: { user: 1, agent: 2, tool: 3 },
      onToggle() {},
    }),
  );
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-label="Filter history by message type"');
  for (const category of HISTORY_CATEGORIES) {
    const label = category[0].toUpperCase() + category.slice(1);
    expect(html).toContain(
      `aria-label="${label}" aria-pressed="${category !== "agent"}"`,
    );
  }
  expect(html).toContain("User<span>1</span>");
  expect(html).toContain("Agent<span>2</span>");
  expect(html).toContain("Tool<span>3</span>");
  expect(html).not.toContain("disabled");
});
