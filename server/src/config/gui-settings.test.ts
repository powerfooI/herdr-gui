import { expect, test } from "bun:test";
import {
  repoSettingsKey,
  workspaceAutoSyncSettingsKey,
  workspaceRepoSettingsKey,
} from "./gui-settings";

test("settings keys preserve legacy format and isolate connection identities", () => {
  const workspace = {
    worktree: {
      repo_key: "same-repo",
      checkout_path: "/same/checkout",
    },
  };

  expect(repoSettingsKey("same-repo")).toBe("local:same-repo");
  expect(repoSettingsKey("same-repo", undefined, "legacy-default")).toBe(
    "local:same-repo",
  );
  expect(repoSettingsKey("same-repo", "same-host", "legacy-default")).toBe(
    "ssh:same-host:same-repo",
  );

  expect(workspaceRepoSettingsKey(workspace, undefined, "alpha")).toBe(
    "connection:alpha:local:same-repo",
  );
  expect(workspaceRepoSettingsKey(workspace, undefined, "beta")).toBe(
    "connection:beta:local:same-repo",
  );
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "alpha"),
  ).toBe("connection:alpha:ssh:same-host:/same/checkout");
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "beta"),
  ).toBe("connection:beta:ssh:same-host:/same/checkout");
  expect(repoSettingsKey("same", undefined, "alpha:local:beta")).toBe(
    "connection:alpha%3Alocal%3Abeta:local:same",
  );
});
