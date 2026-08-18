import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shQuote } from "../utils/process-utils";
import { createWorktreeHookRunner } from "./worktree-hooks";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-hooks-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("worktree hook runner", () => {
  test("loads paseo.json from checkout before source checkout", async () => {
    await withTempDir(async (root) => {
      const checkout = join(root, "checkout");
      const source = join(root, "source");
      await mkdir(checkout);
      await mkdir(source);
      await writeFile(
        join(source, "paseo.json"),
        JSON.stringify({ worktree: { setup: "echo source" } }),
      );
      await writeFile(
        join(checkout, "paseo.json"),
        JSON.stringify({ worktree: { setup: "echo checkout" } }),
      );

      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async () => ({ code: 0, stdout: "", stderr: "" }),
        shQuote,
      });

      await expect(
        runner.readPaseoWorktreeHooks(checkout, source),
      ).resolves.toMatchObject({
        path: join(checkout, "paseo.json"),
        config: { setup: "echo checkout" },
      });
    });
  });

  test("runs configured paseo hooks with expected environment", async () => {
    await withTempDir(async (root) => {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(
        join(root, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup:
              'printf \'%s|%s|%s\' "$PASEO_HOOK" "$PASEO_CHECKOUT_PATH" "$PASEO_SOURCE_CHECKOUT_PATH"',
          },
        }),
      );

      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async (argv) => {
          const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
          const [code, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          return { code, stdout, stderr };
        },
        shQuote,
      });

      const result = await runner.runPaseoWorktreeHook({
        hook: "setup",
        checkoutPath: root,
        sourceCheckoutPath: source,
      });

      expect(result.status).toBe("succeeded");
      expect(result.event).toBe("worktree.created");
      expect(result.stdout).toContain(`config: ${join(root, "paseo.json")}`);
      expect(result.stdout).toContain(`setup|${root}|${source}`);
    });
  });

  test("skips hooks when repo settings disable them", async () => {
    await withTempDir(async (root) => {
      await writeFile(
        join(root, "paseo.json"),
        JSON.stringify({ worktree: { setup: "exit 1" } }),
      );
      const runner = createWorktreeHookRunner({
        herdr: { call: async () => ({}) },
        sshHost: () => undefined,
        runProcess: async () => ({ stdout: "", stderr: "" }),
        runProcessWithCode: async () => {
          throw new Error("should not run");
        },
        shQuote,
        hooksEnabled: async () => false,
      });

      await expect(
        runner.runPaseoWorktreeHook({
          hook: "setup",
          checkoutPath: root,
          repoSettingsKey: "local:repo",
        }),
      ).resolves.toEqual({ event: "worktree.created", status: "skipped" });
    });
  });
});
