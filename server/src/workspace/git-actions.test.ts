import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcessWithCodeTimeout } from "./file-types";
import {
  collectWorktreeFingerprints,
  parseFingerprintListing,
  parseWorkingTreeCounts,
  porcelainAllowsFileAction,
  runGitFileAction,
  runGitRepoAction,
  type GitActionContext,
} from "./git-actions";
import { clearNotARepoCache, collectIgnoredNames } from "./git-ignore";
import { createFileHandlers } from "./files";

const runProcessWithCodeTimeout: RunProcessWithCodeTimeout = async (argv) => {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    5000,
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function status(root: string) {
  return git(
    root,
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
}

async function initRepository(commit = true) {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-actions-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Herdr Test");
  if (commit) {
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "initial");
  }
  return root;
}

async function withRepo<T>(
  commit: boolean,
  fn: (root: string, context: GitActionContext) => Promise<T>,
) {
  const root = await initRepository(commit);
  try {
    return await fn(root, { root, shQuote, runProcessWithCodeTimeout });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fileAction(
  context: GitActionContext,
  params: Record<string, unknown>,
) {
  return runGitFileAction({ context, params });
}

function repoAction(
  context: GitActionContext,
  params: Record<string, unknown>,
) {
  return runGitRepoAction({ context, params });
}

describe("porcelainAllowsFileAction", () => {
  test("matches actions to XY states", () => {
    expect(porcelainAllowsFileAction("stage", "?? new.ts\n")).toBe(true);
    expect(porcelainAllowsFileAction("stage", " M mod.ts\n")).toBe(true);
    expect(porcelainAllowsFileAction("stage", "UU conflict.ts\n")).toBe(true);
    expect(porcelainAllowsFileAction("stage", "M  staged.ts\n")).toBe(false);
    expect(porcelainAllowsFileAction("stage", "")).toBe(false);

    expect(porcelainAllowsFileAction("unstage", "M  staged.ts\n")).toBe(true);
    expect(porcelainAllowsFileAction("unstage", "?? new.ts\n")).toBe(false);
    expect(porcelainAllowsFileAction("unstage", "UU conflict.ts\n")).toBe(
      false,
    );

    expect(porcelainAllowsFileAction("discard_unstaged", " M mod.ts\n")).toBe(
      true,
    );
    expect(porcelainAllowsFileAction("discard_unstaged", "MM both.ts\n")).toBe(
      true,
    );
    expect(
      porcelainAllowsFileAction("discard_unstaged", "M  staged.ts\n"),
    ).toBe(false);
    expect(porcelainAllowsFileAction("discard_unstaged", "?? new.ts\n")).toBe(
      false,
    );
    expect(porcelainAllowsFileAction("discard_unstaged", "UU c.ts\n")).toBe(
      false,
    );

    expect(porcelainAllowsFileAction("delete_untracked", "?? new.ts\n")).toBe(
      true,
    );
    expect(porcelainAllowsFileAction("delete_untracked", " M mod.ts\n")).toBe(
      false,
    );
  });
});

describe("parseWorkingTreeCounts", () => {
  test("counts each working tree bucket", () => {
    expect(
      parseWorkingTreeCounts(
        [
          " M mod.ts",
          "M  staged.ts",
          "MM both.ts",
          "?? new.ts",
          "UU c.ts",
        ].join("\n"),
      ),
    ).toEqual({ staged: 2, unstaged: 2, untracked: 1, conflicted: 1 });
  });
});

describe("parseFingerprintListing", () => {
  test("decodes base64 paths and numeric values", () => {
    const path = "src/uni ü.ts";
    const output = `${Buffer.from(path).toString("base64")}\t12\t1700000000\n`;
    expect(parseFingerprintListing(output).get(path)).toEqual({
      size: 12,
      mtime_ms: 1700000000 * 1000,
    });
  });
});

describe("runGitFileAction", () => {
  test("stages untracked and unstaged files", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "new file ü.txt"), "fresh\n");
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await fileAction(context, { action: "stage", path: "new file ü.txt" });
      await fileAction(context, { action: "stage", path: "tracked.txt" });
      const output = await status(root);
      // Porcelain quotes paths containing spaces.
      expect(output).toContain('A  "new file ü.txt"');
      expect(output).toContain("M  tracked.txt");
    });
  });

  test("rejects staging when nothing changed and reports a refresh", async () => {
    await withRepo(true, async (root, context) => {
      await expect(
        fileAction(context, { action: "stage", path: "tracked.txt" }),
      ).rejects.toThrow(/refresh Changes/);
    });
  });

  test("unstages while preserving the worktree", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await git(root, "add", "tracked.txt");
      await fileAction(context, { action: "unstage", path: "tracked.txt" });
      expect(await status(root)).toContain(" M tracked.txt");
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
    });
  });

  test("unstages a rename using both paths", async () => {
    await withRepo(true, async (root, context) => {
      await git(root, "mv", "tracked.txt", "renamed.txt");
      expect(await status(root)).toContain("R  tracked.txt -> renamed.txt");
      await fileAction(context, {
        action: "unstage",
        path: "renamed.txt",
        old_path: "tracked.txt",
      });
      const output = await status(root);
      expect(output).toContain("?? renamed.txt");
      expect(output).not.toContain("R  ");
    });
  });

  test("unstages on an unborn HEAD", async () => {
    await withRepo(false, async (root, context) => {
      await writeFile(join(root, "new.txt"), "fresh\n");
      await git(root, "add", "new.txt");
      await fileAction(context, { action: "unstage", path: "new.txt" });
      expect(await status(root)).toContain("?? new.txt");
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("fresh\n");
    });
  });

  test("marks conflicted files resolved by staging", async () => {
    await withRepo(true, async (root, context) => {
      await git(root, "checkout", "-b", "side");
      await writeFile(join(root, "tracked.txt"), "side\n");
      await git(root, "commit", "-am", "side");
      await git(root, "checkout", "main");
      await writeFile(join(root, "tracked.txt"), "main\n");
      await git(root, "commit", "-am", "main");
      const merge = await runProcessWithCodeTimeout(
        ["git", "-C", root, "merge", "side"],
        5000,
      );
      expect(merge.code).not.toBe(0);
      expect(await status(root)).toContain("UU tracked.txt");
      await writeFile(join(root, "tracked.txt"), "resolved\n");
      await fileAction(context, { action: "stage", path: "tracked.txt" });
      expect(await status(root)).toContain("M  tracked.txt");
    });
  });

  test("discards unstaged changes and preserves the staged version", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "staged\n");
      await git(root, "add", "tracked.txt");
      await writeFile(join(root, "tracked.txt"), "newer work\n");
      const fingerprint = (
        await collectWorktreeFingerprints(context, ["tracked.txt"])
      ).get("tracked.txt");
      await fileAction(context, {
        action: "discard_unstaged",
        path: "tracked.txt",
        mtime_ms: fingerprint?.mtime_ms,
        size: fingerprint?.size,
      });
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "staged\n",
      );
      expect(await status(root)).toContain("M  tracked.txt");
    });
  });

  test("restores a deleted file when discarding", async () => {
    await withRepo(true, async (root, context) => {
      await rm(join(root, "tracked.txt"));
      await fileAction(context, {
        action: "discard_unstaged",
        path: "tracked.txt",
      });
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");
    });
  });

  test("refuses to discard when the file changed after the refresh", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await expect(
        fileAction(context, {
          action: "discard_unstaged",
          path: "tracked.txt",
          mtime_ms: 1,
          size: 999,
        }),
      ).rejects.toThrow(/refresh Changes/);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
    });
  });

  test("deletes untracked files, including dash-prefixed names", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "-odd name ü.txt"), "temp\n");
      const fingerprint = (
        await collectWorktreeFingerprints(context, ["-odd name ü.txt"])
      ).get("-odd name ü.txt");
      await fileAction(context, {
        action: "delete_untracked",
        path: "-odd name ü.txt",
        mtime_ms: fingerprint?.mtime_ms,
        size: fingerprint?.size,
      });
      expect(await status(root)).not.toContain("-odd name ü.txt");
    });
  });

  test("fails closed on destructive actions without a fingerprint", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await writeFile(join(root, "untracked.txt"), "temp\n");
      await expect(
        fileAction(context, {
          action: "discard_unstaged",
          path: "tracked.txt",
        }),
      ).rejects.toThrow(/refresh Changes/);
      await expect(
        fileAction(context, {
          action: "delete_untracked",
          path: "untracked.txt",
        }),
      ).rejects.toThrow(/refresh Changes/);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
      expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe(
        "temp\n",
      );
    });
  });

  test("refuses to delete a tracked file", async () => {
    await withRepo(true, async (root, context) => {
      await expect(
        fileAction(context, {
          action: "delete_untracked",
          path: "tracked.txt",
        }),
      ).rejects.toThrow(/refresh Changes/);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");
    });
  });

  test("rejects paths escaping the repository", async () => {
    await withRepo(true, async (root, context) => {
      await expect(
        fileAction(context, { action: "stage", path: "../outside.txt" }),
      ).rejects.toThrow(/invalid file explorer path/);
    });
  });
});

describe("runGitRepoAction", () => {
  test("stages and unstages everything", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "new.txt"), "fresh\n");
      await writeFile(join(root, "tracked.txt"), "changed\n");
      const staged = await repoAction(context, { action: "stage_all" });
      expect(staged.counts).toMatchObject({
        staged: 2,
        unstaged: 0,
        untracked: 0,
      });
      const unstaged = await repoAction(context, { action: "unstage_all" });
      expect(unstaged.counts).toMatchObject({
        staged: 0,
        unstaged: 1,
        untracked: 1,
      });
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("fresh\n");
    });
  });

  test("unstages everything on an unborn HEAD", async () => {
    await withRepo(false, async (root, context) => {
      await writeFile(join(root, "new.txt"), "fresh\n");
      await git(root, "add", "new.txt");
      const result = await repoAction(context, { action: "unstage_all" });
      expect(result.counts).toMatchObject({ staged: 0, untracked: 1 });
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("fresh\n");
    });
  });

  test("discards all unstaged changes but preserves staged ones", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "staged\n");
      await git(root, "add", "tracked.txt");
      await writeFile(join(root, "tracked.txt"), "worktree\n");
      const result = await repoAction(context, {
        action: "discard_all_unstaged",
        expected_counts: { unstaged: 1 },
      });
      expect(result.counts).toMatchObject({ staged: 1, unstaged: 0 });
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "staged\n",
      );
    });
  });

  test("refuses repo-wide discard when the counts are stale", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await expect(
        repoAction(context, {
          action: "discard_all_unstaged",
          expected_counts: { unstaged: 0 },
        }),
      ).rejects.toThrow(/refresh Changes/);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
    });
  });

  test("refuses repo-wide discard while conflicts are open", async () => {
    await withRepo(true, async (root, context) => {
      await git(root, "checkout", "-b", "side");
      await writeFile(join(root, "tracked.txt"), "side\n");
      await git(root, "commit", "-am", "side");
      await git(root, "checkout", "main");
      await writeFile(join(root, "tracked.txt"), "main\n");
      await git(root, "commit", "-am", "main");
      await runProcessWithCodeTimeout(
        ["git", "-C", root, "merge", "side"],
        5000,
      );
      await expect(
        repoAction(context, { action: "discard_all_unstaged" }),
      ).rejects.toThrow(/resolve conflicted files/);
    });
  });

  test("deletes all untracked files but keeps ignored ones", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, ".gitignore"), "ignored.txt\n");
      await git(root, "add", ".gitignore");
      await git(root, "commit", "-m", "ignore");
      await writeFile(join(root, "temp.txt"), "temp\n");
      await writeFile(join(root, "ignored.txt"), "keep\n");
      const result = await repoAction(context, {
        action: "delete_all_untracked",
        expected_counts: { untracked: 1 },
      });
      expect(result.counts.untracked).toBe(0);
      expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("keep\n");
    });
  });
});

describe("createFileHandlers git support end to end", () => {
  function handlersFor(root: string) {
    return createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get") {
            return {
              workspace: {
                workspace_id: "w1",
                label: "Repo",
                worktree: { checkout_path: root },
              },
            };
          }
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout,
      shQuote,
    });
  }

  test("runs file and repo actions against a real repository", async () => {
    await withRepo(true, async (root) => {
      const handlers = handlersFor(root);
      await writeFile(join(root, "new.txt"), "fresh\n");
      const staged = await handlers.runWorkspaceGitFileAction({
        workspace_id: "w1",
        action: "stage",
        path: "new.txt",
      });
      expect(staged).toMatchObject({
        workspace_id: "w1",
        root: await realpath(root),
        action: "stage",
        path: "new.txt",
      });
      expect(await status(root)).toContain("A  new.txt");
      const repo = await handlers.runWorkspaceGitRepoAction({
        workspace_id: "w1",
        action: "unstage_all",
      });
      expect(repo.counts).toMatchObject({ staged: 0, untracked: 1 });
    });
  });

  test("attaches worktree fingerprints to working summary entries", async () => {
    await withRepo(true, async (root) => {
      const handlers = handlersFor(root);
      await writeFile(join(root, "tracked.txt"), "changed\n");
      const summary = await handlers.readGitDiffSummary({
        workspace_id: "w1",
        mode: "working",
      });
      const modified = summary.entries.find(
        (entry) => entry.path === "tracked.txt",
      );
      expect(modified?.size).toBe("changed\n".length);
      expect(modified?.mtime_ms ?? 0).toBeGreaterThan(0);
    });
  });

  test("marks git-ignored entries in file listings", async () => {
    await withRepo(true, async (root) => {
      await writeFile(join(root, ".gitignore"), "build-output/\n*.log\n");
      await mkdir(join(root, "build-output"));
      await writeFile(join(root, "debug.log"), "x");
      const handlers = handlersFor(root);
      const list = await handlers.listWorkspaceFiles({
        workspace_id: "w1",
        show_hidden: true,
      });
      const byName = new Map(list.entries.map((entry) => [entry.name, entry]));
      expect(byName.get("debug.log")?.ignored).toBe(true);
      expect(byName.get("build-output")?.ignored).toBe(true);
      expect(byName.get("tracked.txt")?.ignored).toBeUndefined();
      expect(byName.get(".gitignore")?.ignored).toBeUndefined();
    });
  });
});

describe("collectIgnoredNames", () => {
  test("marks ignored entries and leaves others alone", async () => {
    await withRepo(true, async (root, context) => {
      await writeFile(join(root, ".gitignore"), "build/\n*.log\n");
      await writeFile(join(root, "debug.log"), "log\n");
      const names = await collectIgnoredNames({
        directory: root,
        names: ["tracked.txt", "debug.log", ".gitignore", "missing dir"],
        shQuote: context.shQuote,
      });
      expect(names).toEqual(new Set(["debug.log"]));
    });
  });

  test("returns an empty set outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-not-a-repo-"));
    try {
      const names = await collectIgnoredNames({
        directory: dir,
        names: ["file.txt"],
        shQuote,
      });
      expect(names.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("caches non-repository directories and skips spawning again", async () => {
    clearNotARepoCache();
    let spawns = 0;
    const runner = async () => {
      spawns += 1;
      return { code: 128, stdout: "", stderr: "not a repo" };
    };
    const args = {
      directory: "/not-a-repo",
      names: ["file.txt"],
      shQuote,
      runProcess: runner,
    };
    expect((await collectIgnoredNames(args)).size).toBe(0);
    expect((await collectIgnoredNames(args)).size).toBe(0);
    expect(spawns).toBe(1);
  });

  test("does not cache successful ignore checks", async () => {
    clearNotARepoCache();
    let spawns = 0;
    const runner = async () => {
      spawns += 1;
      return { code: 1, stdout: "", stderr: "" };
    };
    const args = {
      directory: "/some-repo",
      names: ["file.txt"],
      shQuote,
      runProcess: runner,
    };
    await collectIgnoredNames(args);
    await collectIgnoredNames(args);
    expect(spawns).toBe(2);
  });
});
