import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../types";
import { store, useStore } from "../store";
import { luckyWorktreeBranchName } from "../luckyName";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { WorktreeHooksDialog } from "./WorktreeHooksDialog";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { WorkspaceAutoSyncDialog } from "./WorkspaceAutoSyncDialog";
import { worktreeCreationSource } from "../worktree";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";
import { isWorkspacePinned } from "../workspacePins";
import { copyTextFromUserGesture } from "../terminalClipboard";

export interface ContextMenuState {
  x: number;
  y: number;
  workspace: Workspace;
}

interface Item {
  label: string;
  danger?: boolean;
  action: () => void;
}

type DialogState =
  | {
      type: "new-worktree";
      workspaceId: string;
      branch: string;
    }
  | {
      type: "rename-workspace";
      workspaceId: string;
      label: string;
    }
  | {
      type: "remove-worktree";
      workspaceId: string;
      label: string;
    }
  | {
      type: "close-workspace";
      workspaceId: string;
      label: string;
    };

export function ContextMenu({
  state,
  pinnedWorkspaceKeys,
  onPinnedChange,
  onBrowseFiles,
  onReviewChanges,
  onClose,
}: {
  state: ContextMenuState | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  onPinnedChange: (workspace: Workspace, pinned: boolean) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  const workspaces = useStore().workspaces;
  const ref = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [openWorktreeWorkspaceId, setOpenWorktreeWorkspaceId] = useState<
    string | null
  >(null);
  const [worktreeHooksWorkspaceId, setWorktreeHooksWorkspaceId] = useState<
    string | null
  >(null);
  const [autoSyncWorkspaceId, setAutoSyncWorkspaceId] = useState<string | null>(
    null,
  );
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the triggering contextmenu event doesn't immediately close it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onClose, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  const dialogs = (
    <>
      <TextInputDialog
        open={dialog?.type === "new-worktree"}
        title="New Worktree"
        label="Branch"
        initialValue={dialog?.type === "new-worktree" ? dialog.branch : ""}
        placeholder="Branch name"
        submitLabel="Create"
        onClose={() => setDialog(null)}
        onSubmit={(branch) => {
          const value = branch.trim();
          if (dialog?.type === "new-worktree" && value) {
            store.createWorktree(dialog.workspaceId, value);
            setDialog(null);
          }
        }}
      />
      <TextInputDialog
        open={dialog?.type === "rename-workspace"}
        title="Rename Workspace"
        label="Name"
        initialValue={dialog?.type === "rename-workspace" ? dialog.label : ""}
        submitLabel="Rename"
        onClose={() => setDialog(null)}
        onSubmit={(label) => {
          const value = label.trim();
          if (dialog?.type === "rename-workspace" && value) {
            if (value !== dialog.label) {
              store.renameWorkspace(dialog.workspaceId, value);
            }
            setDialog(null);
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.type === "remove-worktree"}
        title="Remove Worktree"
        message={
          dialog?.type === "remove-worktree"
            ? `Remove worktree "${dialog.label}"?`
            : ""
        }
        confirmLabel="Remove"
        danger
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.type === "remove-worktree") {
            store.removeWorktree(dialog.workspaceId, false);
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.type === "close-workspace"}
        title="Close Workspace"
        message={
          dialog?.type === "close-workspace"
            ? `Close workspace "${dialog.label}"?`
            : ""
        }
        confirmLabel="Close"
        danger
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.type === "close-workspace") {
            store.closeWorkspace(dialog.workspaceId);
          }
        }}
      />
    </>
  );

  const openWorktreeDialog = (
    <WorktreeOpenDialog
      open={!!openWorktreeWorkspaceId}
      workspaceId={openWorktreeWorkspaceId}
      onClose={() => setOpenWorktreeWorkspaceId(null)}
    />
  );
  const worktreeHooksDialog = (
    <WorktreeHooksDialog
      open={!!worktreeHooksWorkspaceId}
      workspaceId={worktreeHooksWorkspaceId ?? undefined}
      onClose={() => setWorktreeHooksWorkspaceId(null)}
    />
  );
  const autoSyncDialog = (
    <WorkspaceAutoSyncDialog
      open={!!autoSyncWorkspaceId}
      workspaceId={autoSyncWorkspaceId ?? undefined}
      onClose={() => setAutoSyncWorkspaceId(null)}
    />
  );
  const lifecycleDialog = (
    <WorktreeLifecycleDialog
      open={!!lifecycleWorkspaceId}
      workspaceId={lifecycleWorkspaceId}
      onClose={() => setLifecycleWorkspaceId(null)}
    />
  );
  if (!state) {
    return (
      <>
        {dialogs}
        {openWorktreeDialog}
        {worktreeHooksDialog}
        {autoSyncDialog}
        {lifecycleDialog}
      </>
    );
  }
  const w =
    workspaces.find(
      (workspace) => workspace.workspace_id === state.workspace.workspace_id,
    ) ?? state.workspace;
  const isLinked = !!w.worktree?.is_linked_worktree;
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
  const creationSource = worktreeCreationSource(workspaces, w);

  const items: Item[] = [
    {
      label: "Open Files in Inspector",
      action: () => onBrowseFiles?.(w),
    },
    {
      label: "Open Changes in Inspector",
      action: () => onReviewChanges?.(w),
    },
    {
      label: `${pinned ? "Unpin" : "Pin"} ${isLinked ? "worktree" : "workspace"}`,
      action: () => onPinnedChange(w, !pinned),
    },
  ];
  if (w.worktree) {
    items.push({
      label: "Copy checkout path",
      action: () => {
        const path = w.worktree?.checkout_path;
        if (!path) return;
        void copyTextFromUserGesture(path).then(
          () =>
            store.notify({
              kind: "success",
              message: "Checkout path copied",
              detail: path,
              autoDismissMs: 5000,
            }),
          (error) =>
            store.notify({
              kind: "error",
              message: "Failed to copy checkout path",
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
      },
    });
    items.push({
      label: "Worktree lifecycle…",
      action: () => {
        setLifecycleWorkspaceId(w.workspace_id);
      },
    });
    items.push({
      label: "Open worktree…",
      action: () => {
        setOpenWorktreeWorkspaceId(w.workspace_id);
      },
    });
    items.push({
      label: "Worktree hooks…",
      action: () => {
        setWorktreeHooksWorkspaceId(w.workspace_id);
      },
    });
  }
  if (creationSource) {
    items.push({
      label: "New worktree…",
      action: () => {
        setDialog({
          type: "new-worktree",
          workspaceId: creationSource.workspace_id,
          branch: luckyWorktreeBranchName(),
        });
      },
    });
  }
  items.push({
    label: "Git pull",
    action: () => {
      void store.gitPullWorkspace(w.workspace_id);
    },
  });
  items.push({
    label: "Auto-update branch…",
    action: () => {
      setAutoSyncWorkspaceId(w.workspace_id);
    },
  });
  items.push({
    label: "Rename workspace…",
    action: () => {
      setDialog({
        type: "rename-workspace",
        workspaceId: w.workspace_id,
        label: w.label,
      });
    },
  });
  if (isLinked) {
    items.push({
      label: "Remove worktree",
      danger: true,
      action: () => {
        setDialog({
          type: "remove-worktree",
          workspaceId: w.workspace_id,
          label: w.label,
        });
      },
    });
  }
  items.push({
    label: "Close workspace",
    danger: true,
    action: () => {
      setDialog({
        type: "close-workspace",
        workspaceId: w.workspace_id,
        label: w.label,
      });
    },
  });

  // Keep the menu on-screen, including narrow mobile viewports.
  const menuMargin = 8;
  const menuWidth = 200;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(
      menuMargin,
      Math.min(state.x, window.innerWidth - menuWidth - menuMargin),
    ),
    top: Math.max(
      menuMargin,
      Math.min(state.y, window.innerHeight - items.length * 34 - menuMargin),
    ),
    zIndex: 1000,
  };

  return (
    <>
      <div ref={ref} className="context-menu" style={style}>
        {items.map((it, i) => (
          <button
            key={i}
            className={`context-menu-item ${it.danger ? "is-danger" : ""}`}
            onClick={() => {
              onClose();
              it.action();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
      {dialogs}
      {openWorktreeDialog}
      {worktreeHooksDialog}
      {autoSyncDialog}
      {lifecycleDialog}
    </>
  );
}
