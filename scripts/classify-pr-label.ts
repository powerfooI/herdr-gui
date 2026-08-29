import { readFileSync } from "node:fs";

export type PullRequestLabel =
  | "breaking-change"
  | "bug"
  | "dependencies"
  | "documentation"
  | "enhancement"
  | "skip-changelog";

export type PullRequestLabelInput = {
  title: string;
  author: string;
  changedFiles: number;
  files: string[];
};

const FIX_TITLE = /^(fix|repair|restore|prevent|correct|resolve|harden)\b/i;
const DEPENDENCY_TITLE =
  /^(bump\s+actions\/|(?:update|upgrade)\s+(dependencies|dependency|packages?)\b)/i;
const BREAKING_TITLE =
  /^(breaking(?:[ -]change)?\s*[:!-]|\[breaking(?:[ -]change)?\])/i;

function isDocumentationFile(path: string) {
  return (
    path.endsWith(".md") ||
    path === "LICENSE" ||
    path.startsWith("docs/") ||
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path.startsWith(".github/PULL_REQUEST_TEMPLATE/")
  );
}

function isDependencyFile(path: string) {
  return (
    path === "bun.lock" ||
    path.endsWith("/bun.lock") ||
    path === "package.json" ||
    path.endsWith("/package.json") ||
    path === ".github/dependabot.yml"
  );
}

export function classifyPullRequestLabel({
  title,
  author,
  changedFiles,
  files,
}: PullRequestLabelInput): PullRequestLabel {
  const normalizedTitle = title.trim();
  if (author === "github-actions[bot]") return "skip-changelog";
  if (BREAKING_TITLE.test(normalizedTitle)) return "breaking-change";
  if (files.length !== changedFiles) return "enhancement";
  if (files.length > 0 && files.every(isDocumentationFile)) {
    return "documentation";
  }
  if (
    author === "dependabot[bot]" ||
    DEPENDENCY_TITLE.test(normalizedTitle) ||
    (files.length > 0 && files.every(isDependencyFile))
  ) {
    return "dependencies";
  }
  if (FIX_TITLE.test(normalizedTitle)) return "bug";
  return "enhancement";
}

function parseInput(value: unknown): PullRequestLabelInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("labeler input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.title !== "string" ||
    typeof input.author !== "string" ||
    typeof input.changedFiles !== "number" ||
    !Number.isSafeInteger(input.changedFiles) ||
    input.changedFiles < 0 ||
    !Array.isArray(input.files) ||
    !input.files.every((file) => typeof file === "string")
  ) {
    throw new Error(
      "labeler input requires title, author, changedFiles, and string files",
    );
  }
  return {
    title: input.title,
    author: input.author,
    changedFiles: input.changedFiles,
    files: input.files as string[],
  };
}

if (import.meta.main) {
  let input: PullRequestLabelInput;
  try {
    input = parseInput(JSON.parse(readFileSync(0, "utf8")));
  } catch (error) {
    throw new Error("failed to parse pull request labeler input", {
      cause: error,
    });
  }
  process.stdout.write(`${classifyPullRequestLabel(input)}\n`);
}
