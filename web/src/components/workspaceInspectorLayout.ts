export const WORKSPACE_INSPECTOR_COMPACT_WIDTH = 640;

export function workspaceInspectorLayout(width: number): {
  compact: boolean;
  splitEnabled: boolean;
} {
  return {
    compact: width > 0 && width < WORKSPACE_INSPECTOR_COMPACT_WIDTH,
    splitEnabled: width >= WORKSPACE_INSPECTOR_COMPACT_WIDTH,
  };
}
