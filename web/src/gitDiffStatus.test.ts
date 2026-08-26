import { describe, expect, test } from "bun:test";
import { gitDiffCode } from "./gitDiffStatus";

describe("gitDiffCode", () => {
  test("normalizes explorer and diff viewer states to U/A/M/D/C", () => {
    expect(gitDiffCode({ kind: "untracked", status: "added" })).toBe("U");
    expect(gitDiffCode({ kind: "staged", status: "added" })).toBe("A");
    expect(gitDiffCode({ kind: "unstaged", status: "M" })).toBe("M");
    expect(gitDiffCode({ kind: "staged", status: "deleted" })).toBe("D");
    expect(gitDiffCode({ kind: "conflicted", status: "modified" })).toBe("C");
  });
});
