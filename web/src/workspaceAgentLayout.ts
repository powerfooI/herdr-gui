export const WORKSPACE_AGENT_LAYOUT_STORAGE_KEY = "workspaceAgentLayout";

export type WorkspaceAgentLayout = "nested" | "separate";

export function parseWorkspaceAgentLayout(
  value: string | null | undefined,
): WorkspaceAgentLayout {
  return value === "separate" ? "separate" : "nested";
}
