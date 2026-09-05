import { expect, test } from "bun:test";
import { historyEntriesFromTrajectory, historyUpdate } from "./session-history";
import { projectAgentTrajectory } from "./session-trajectory";

const file = { path: "/tmp/history.jsonl", mtimeMs: 1000 };

test("Pi History includes tool arguments, associated outputs and errors in transcript order", () => {
  const records = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "run it" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running" },
          {
            type: "toolCall",
            id: "call1",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        isError: true,
        content: [{ type: "text", text: "exit 1" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Failed" }],
      },
    },
  ];
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("pi", file, records),
  );
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "message",
    "tool_call",
    "tool_result",
    "message",
  ]);
  expect(entries[2]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: '{\n  "command": "false"\n}',
  });
  expect(entries[3]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: "exit 1",
    is_error: true,
  });
});

test("Claude mixed text/tool blocks retain order and error output is not counted as a user turn", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test-model",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "text", text: "Before" },
          {
            type: "tool_use",
            id: "call",
            name: "Read",
            input: { path: "missing" },
          },
          { type: "text", text: "After" },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: "not found",
            is_error: true,
          },
          { type: "text", text: "Try again" },
        ],
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "tool_call",
    "message",
    "tool_result",
    "message",
  ]);
  expect(entries[3]).toMatchObject({
    tool_name: "Read",
    source_call_id: "call",
    is_error: true,
    text: "not found",
  });
  expect(entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  expect(trajectory.steps[2]).toMatchObject({
    extra: { record_type: "assistant", model: "claude-test-model" },
    metrics: { prompt_tokens: 10, completion_tokens: 5 },
  });
  expect(trajectory.steps[4].extra?.record_type).toBe("user");
});

test("Pi interleaved tool and text parts remain in source order", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "read",
            arguments: { path: "a" },
          },
          { type: "text", text: "After call" },
          {
            type: "toolCall",
            id: "call2",
            name: "read",
            arguments: { path: "b" },
          },
        ],
      },
    },
  ]);
  expect(
    historyEntriesFromTrajectory(file, trajectory).map((entry) => entry.kind),
  ).toEqual(["tool_call", "message", "tool_call"]);
});

test.each(["stop", "error"])(
  "Pi interleaved ATIF preserves source metadata with stop reason %s",
  (stopReason) => {
    const trajectory = projectAgentTrajectory("pi", file, [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          stopReason,
          errorMessage: "interrupted",
          usage: { input: 10, output: 5 },
          content: [
            { type: "toolCall", id: "call", name: "read", arguments: {} },
            { type: "text", text: "After call" },
          ],
        },
      },
    ]);
    const lastStep = trajectory.steps.at(-1)!;
    expect(lastStep).toMatchObject({
      extra: {
        record_type: "message",
        provider: "test-provider",
        model: "test-model",
        stop_reason: stopReason,
      },
      metrics: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(lastStep.extra?.error_message).toBe(
      stopReason === "error" ? "interrupted" : undefined,
    );
  },
);

test("Codex preserves explicit tool errors and call association", () => {
  const trajectory = projectAgentTrajectory("codex", file, [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call",
        arguments: '{"command":"false"}',
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call",
        output: "exit 1",
        status: "failed",
      },
    },
  ]);
  expect(historyEntriesFromTrajectory(file, trajectory)[1]).toMatchObject({
    kind: "tool_result",
    source_call_id: "call",
    tool_name: "shell",
    text: "exit 1",
    is_error: true,
  });
});

test("external call IDs with commas are hashed before order comparison", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: ["a,b", "c", "a", "b,c"].map((id) => ({
          type: "toolCall",
          id,
          name: "read",
          arguments: {},
        })),
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  for (const entry of entries) expect(entry.id).toMatch(/^[0-9a-f]{24}:\d+$/);
  expect(entries.map((entry) => entry.source_call_id)).toEqual([
    "a,b",
    "c",
    "a",
    "b,c",
  ]);
  const reversed = entries.toReversed();
  const update = historyUpdate(
    { epoch: "test", revision: 2 },
    reversed,
    { epoch: "test", revision: 1 },
    new Map([[1, entries]]),
  );
  expect(update).toMatchObject({
    mode: "delta",
    upserts: [],
    removed: [],
    order: reversed.map((entry) => entry.id),
  });
});

test("content identities survive early step renumbering and disambiguate repeated messages", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    { type: "message", message: { role: "user", content: "same" } },
    { type: "message", message: { role: "user", content: "same" } },
  ]);
  const first = historyEntriesFromTrajectory(file, trajectory);
  const next = historyEntriesFromTrajectory(file, {
    ...trajectory,
    steps: trajectory.steps.map((step) => ({
      ...step,
      step_id: step.step_id + 3,
    })),
  });
  expect(first.map((entry) => entry.id)).toEqual(next.map((entry) => entry.id));
  expect(new Set(first.map((entry) => entry.id)).size).toBe(2);
});
