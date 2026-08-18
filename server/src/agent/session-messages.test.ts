import { describe, expect, test } from "bun:test";
import { conversationMessagesFromTrajectory } from "./session-messages";
import type { AtifTrajectory, SessionFile } from "./session-types";

const file: SessionFile = {
  path: "/tmp/session.jsonl",
  mtimeMs: Date.parse("2026-07-28T00:00:00.000Z"),
};

function trajectory(steps: AtifTrajectory["steps"]): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.7",
    agent: { name: "pi", version: "1" },
    steps,
  };
}

describe("session conversation messages", () => {
  test("keeps user and presented assistant text in chronological order", () => {
    const messages = conversationMessagesFromTrajectory(
      file,
      trajectory([
        {
          step_id: 1,
          timestamp: "2026-07-28T00:00:01.000Z",
          source: "user",
          message: "Inspect the repository",
        },
        {
          step_id: 2,
          timestamp: "2026-07-28T00:00:02.000Z",
          source: "agent",
          message: "I will inspect it.",
          tool_calls: [
            {
              tool_call_id: "call-1",
              function_name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          step_id: 3,
          timestamp: "2026-07-28T00:00:03.000Z",
          source: "agent",
          message: "Done",
        },
      ]),
    );

    expect(messages).toMatchObject([
      { role: "user", text: "Inspect the repository" },
      { role: "assistant", text: "I will inspect it." },
      { role: "assistant", text: "Done" },
    ]);
  });

  test("omits reasoning, generated tool labels, errors, and token records", () => {
    const messages = conversationMessagesFromTrajectory(
      file,
      trajectory([
        {
          step_id: 1,
          source: "agent",
          message: "Reasoning",
          reasoning_content: "Inspect files",
        },
        {
          step_id: 2,
          source: "agent",
          message: "Tool call: read",
          tool_calls: [
            {
              tool_call_id: "call-1",
              function_name: "read",
              arguments: {},
            },
          ],
        },
        {
          step_id: 3,
          source: "system",
          message: "Tool result",
        },
        {
          step_id: 4,
          source: "system",
          message: "Token usage",
          metrics: { prompt_tokens: 10 },
        },
        {
          step_id: 5,
          source: "agent",
          message: "Error: rate limited",
          extra: { error_message: "rate limited" },
        },
      ]),
    );

    expect(messages).toEqual([]);
  });
});
