import {
  readGuiSettings,
  repoSettingsKey,
  updateGuiSettings,
  type GuiSettings,
} from "../config/gui-settings";

const CUSTOM_SETTINGS_KEY = "worktree_parent_by_checkout";

type HerdrCaller = {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
};

type ParentRecords = Record<string, string>;

function checkoutPath(workspace: any): string | null {
  const value =
    workspace?.worktree?.checkout_path ??
    workspace?.worktree?.path ??
    workspace?.checkout_path ??
    workspace?.path;
  return typeof value === "string" && value ? value : null;
}

function parentRecords(settings: Pick<GuiSettings, "custom">): ParentRecords {
  const raw = settings.custom[CUSTOM_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const records: ParentRecords = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value) records[key] = value;
  }
  return records;
}

function withParentRecords(
  settings: GuiSettings,
  records: ParentRecords,
): GuiSettings {
  return {
    ...settings,
    custom: {
      ...settings.custom,
      [CUSTOM_SETTINGS_KEY]: records,
    },
  };
}

// Parent workspace identity is GUI-specific metadata that Herdr does not
// expose. Validate persisted IDs against the current list before returning
// them so stale data from a previous Herdr lifecycle cannot misgroup items.
export function attachWorktreeParents(
  result: any,
  settings: Pick<GuiSettings, "custom">,
  host?: string,
): any {
  if (!Array.isArray(result?.workspaces)) return result;
  const records = parentRecords(settings);
  const workspaceById = new Map<string, any>(
    result.workspaces.map((workspace: any) => [
      String(workspace?.workspace_id ?? ""),
      workspace,
    ]),
  );

  return {
    ...result,
    workspaces: result.workspaces.map((workspace: any) => {
      if (!workspace?.worktree?.is_linked_worktree) return workspace;
      const path = checkoutPath(workspace);
      if (!path) return workspace;
      const parentWorkspaceId = records[repoSettingsKey(path, host)];
      const parent = parentWorkspaceId
        ? workspaceById.get(parentWorkspaceId)
        : undefined;
      const parentMatches =
        parent &&
        parent !== workspace &&
        parent?.worktree?.is_linked_worktree === false &&
        parent.worktree.repo_key === workspace.worktree.repo_key;
      if (!parentMatches) return workspace;
      return {
        ...workspace,
        worktree: {
          ...workspace.worktree,
          parent_workspace_id: parentWorkspaceId,
        },
      };
    }),
  };
}

export function createWorktreeParentStore({
  herdr,
  sshHost,
}: {
  herdr: HerdrCaller;
  sshHost: () => string | undefined;
}) {
  async function resolveWorktreeWorkspace(result: any): Promise<any | null> {
    const directWorkspace = result?.workspace;
    if (directWorkspace?.worktree) return directWorkspace;
    const workspaceId =
      directWorkspace?.workspace_id ??
      result?.workspace_id ??
      result?.worktree?.workspace_id ??
      result?.worktree?.open_workspace_id;
    if (workspaceId) {
      const response = await herdr
        .call("workspace.get", { workspace_id: String(workspaceId) })
        .catch(() => null);
      if (response?.workspace) return response.workspace;
    }
    const path = checkoutPath(result?.worktree ?? result);
    if (!path) return null;
    const response = await herdr.call("workspace.list", {}).catch(() => null);
    return (
      response?.workspaces?.find(
        (workspace: any) => checkoutPath(workspace) === path,
      ) ??
      directWorkspace ??
      null
    );
  }

  async function rememberWorktreeParent(
    result: any,
    parentWorkspaceId: string,
  ): Promise<void> {
    const workspace = await resolveWorktreeWorkspace(result);
    const path = checkoutPath(workspace);
    if (
      !path ||
      !parentWorkspaceId ||
      workspace?.workspace_id === parentWorkspaceId ||
      workspace?.worktree?.is_linked_worktree !== true
    ) {
      return;
    }
    const key = repoSettingsKey(path, sshHost());
    await updateGuiSettings((settings) =>
      withParentRecords(settings, {
        ...parentRecords(settings),
        [key]: parentWorkspaceId,
      }),
    );
  }

  async function forgetWorktree(path: string): Promise<void> {
    if (!path) return;
    const key = repoSettingsKey(path, sshHost());
    await updateGuiSettings((settings) => {
      const records = parentRecords(settings);
      if (!(key in records)) return settings;
      const next = { ...records };
      delete next[key];
      return withParentRecords(settings, next);
    });
  }

  async function enrichWorkspaceList(result: any): Promise<any> {
    return attachWorktreeParents(result, await readGuiSettings(), sshHost());
  }

  return {
    rememberWorktreeParent,
    forgetWorktree,
    enrichWorkspaceList,
  };
}
