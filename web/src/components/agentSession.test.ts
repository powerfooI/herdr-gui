import { describe, expect, test } from "bun:test";
import {
  firstLinePreview,
  groupTrajectoryTurns,
  type AgentSessionTrajectoryStep,
  toolArgumentsPreview,
  visibleSessionMessages,
} from "./agentSession";

function step(
  stepId: number,
  source: AgentSessionTrajectoryStep["source"],
  message: string,
): AgentSessionTrajectoryStep {
  return {
    step_id: stepId,
    source,
    message,
  };
}

describe("agent session presentation", () => {
  test("groups setup records and subsequent activity into user turns", () => {
    const groups = groupTrajectoryTurns([
      step(1, "system", "session start"),
      step(2, "user", "first request"),
      step(3, "agent", "first response"),
      step(4, "system", "tool result"),
      step(5, "user", "second request"),
      step(6, "agent", "second response"),
    ]);

    expect(groups.map((group) => group.number)).toEqual([null, 1, 2]);
    expect(
      groups.map((group) => group.steps.map((item) => item.step_id)),
    ).toEqual([[1], [2, 3, 4], [5, 6]]);
  });

  test("keeps agent-only trajectories in a setup group", () => {
    const groups = groupTrajectoryTurns([
      step(1, "agent", "restored response"),
      step(2, "system", "usage"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].number).toBeNull();
    expect(groups[0].steps).toHaveLength(2);
  });

  test("filters assistant messages without renumbering user messages", () => {
    const messages = [
      { role: "user" as const, text: "first" },
      { role: "assistant" as const, text: "response" },
      { role: "user" as const, text: "second" },
    ];

    expect(visibleSessionMessages(messages, true)).toMatchObject([
      { sequence: 1, message: { text: "first" } },
      { sequence: 2, message: { text: "response" } },
      { sequence: 3, message: { text: "second" } },
    ]);
    expect(visibleSessionMessages(messages, false)).toMatchObject([
      { sequence: 1, message: { text: "first" } },
      { sequence: 3, message: { text: "second" } },
    ]);
  });

  test("previews tool call arguments by priority key", () => {
    expect(
      toolArgumentsPreview({ command: "ls\napps/roadie", cwd: "/repo" }),
    ).toBe("ls apps/roadie");
    expect(toolArgumentsPreview({ file_path: "src/index.ts" })).toBe(
      "src/index.ts",
    );
    expect(toolArgumentsPreview({}, "List files in apps/roadie")).toBe(
      "List files in apps/roadie",
    );
    expect(toolArgumentsPreview({ a: 1 })).toBe('{"a":1}');
    expect(
      toolArgumentsPreview({ command: "x".repeat(120) }, undefined, 10),
    ).toBe(`${"x".repeat(10)}…`);
  });

  test("previews the first non-empty line with truncation", () => {
    expect(firstLinePreview("\n  first line  \nsecond")).toBe("first line");
    expect(firstLinePreview("")).toBe("");
    expect(firstLinePreview("x".repeat(120), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
