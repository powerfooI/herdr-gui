import { describe, expect, test } from "bun:test";
import { workspaceInspectorLayout } from "./workspaceInspectorLayout";

describe("workspace Inspector responsive layout", () => {
  test("uses compact drill-in navigation at 574px", () => {
    expect(workspaceInspectorLayout(574)).toEqual({
      compact: true,
      splitEnabled: false,
    });
  });

  test("enables the two-pane split only at 640px and above", () => {
    expect(workspaceInspectorLayout(639)).toEqual({
      compact: true,
      splitEnabled: false,
    });
    expect(workspaceInspectorLayout(640)).toEqual({
      compact: false,
      splitEnabled: true,
    });
  });

  test("does not assume compact layout before the host is measured", () => {
    expect(workspaceInspectorLayout(0)).toEqual({
      compact: false,
      splitEnabled: false,
    });
  });
});
