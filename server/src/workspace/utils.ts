export function uniqueStrings(
  values: Array<string | undefined | null>,
): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value))),
  );
}

// Prefer Herdr's worktree provenance, falling back to the workspace cwd.
export function checkoutPath(workspace: any): string {
  return (
    (typeof workspace?.worktree?.checkout_path === "string" &&
      workspace.worktree.checkout_path) ||
    (typeof workspace?.cwd === "string" && workspace.cwd) ||
    ""
  );
}

// Use the source checkout when Herdr exposes it; otherwise use the checkout.
export function sourceCheckoutPath(workspace: any): string {
  return (
    (typeof workspace?.worktree?.repo_root === "string" &&
      workspace.worktree.repo_root) ||
    checkoutPath(workspace)
  );
}
