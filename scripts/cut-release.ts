#!/usr/bin/env bun
// Cut a release without a version-bump PR: bump the three package.json
// versions, finalize the CHANGELOG "Unreleased" section, commit, tag, and
// optionally push. Pushing the tag (or dispatching the Release workflow on
// it) builds and publishes the release.
//
// Usage:
//   bun scripts/cut-release.ts <X.Y.Z | patch | minor | major> [--push]
//   bun scripts/cut-release.ts 0.4.2            # commit + tag locally
//   bun scripts/cut-release.ts patch --push     # commit, tag, push to origin
//
// Flags:
//   --push        Push the release commit and tag to origin.
//   --any-branch  Allow cutting from a branch other than main.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_FILES = [
  "package.json",
  "web/package.json",
  "server/package.json",
];
const CHANGELOG_FILE = "CHANGELOG.md";
const RELEASE_FILES = [...PACKAGE_FILES, CHANGELOG_FILE];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parsePackageVersion(packageJsonText: string): string {
  const match = /^(\s*)"version": "([^"]+)"/m.exec(packageJsonText);
  if (!match) {
    throw new Error('package.json has no top-level "version" field');
  }
  return match[2];
}

export function replacePackageVersion(
  packageJsonText: string,
  expectedCurrent: string,
  next: string,
): string {
  const match = /^(\s*)"version": "([^"]+)"/m.exec(packageJsonText);
  if (!match || match.index === undefined) {
    throw new Error('package.json has no top-level "version" field');
  }
  if (match[2] !== expectedCurrent) {
    throw new Error(
      `package.json version is ${match[2]}, expected ${expectedCurrent}`,
    );
  }
  return `${packageJsonText.slice(0, match.index)}${match[1]}"version": "${next}"${packageJsonText.slice(
    match.index + match[0].length,
  )}`;
}

export function resolveNextVersion(current: string, input: string): string {
  const currentMatch = SEMVER_RE.exec(current);
  if (!currentMatch) {
    throw new Error(`Current version "${current}" is not in X.Y.Z form`);
  }
  const currentTuple = [
    Number(currentMatch[1]),
    Number(currentMatch[2]),
    Number(currentMatch[3]),
  ];
  if (input === "patch") {
    return `${currentTuple[0]}.${currentTuple[1]}.${currentTuple[2] + 1}`;
  }
  if (input === "minor") {
    return `${currentTuple[0]}.${currentTuple[1] + 1}.0`;
  }
  if (input === "major") {
    return `${currentTuple[0] + 1}.0.0`;
  }
  const nextMatch = SEMVER_RE.exec(input);
  if (!nextMatch) {
    throw new Error(`Version "${input}" must be X.Y.Z or patch|minor|major`);
  }
  const candidate = [
    Number(nextMatch[1]),
    Number(nextMatch[2]),
    Number(nextMatch[3]),
  ];
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] > currentTuple[index]) return input;
    if (candidate[index] < currentTuple[index]) break;
  }
  throw new Error(
    `Version ${input} must be greater than the current ${current}`,
  );
}

export function rotateChangelog(
  changelogText: string,
  version: string,
  date: string,
): string {
  if (new RegExp(`^## ${version}( |$)`, "m").test(changelogText)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const unreleasedMatch = /^## Unreleased\s*$/m.exec(changelogText);
  if (!unreleasedMatch || unreleasedMatch.index === undefined) {
    throw new Error('CHANGELOG.md has no "## Unreleased" section');
  }
  const bodyStart = unreleasedMatch.index + unreleasedMatch[0].length;
  const rest = changelogText.slice(bodyStart);
  const nextHeading = rest.search(/^## /m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (!/^- /m.test(body)) {
    throw new Error(
      'CHANGELOG.md "Unreleased" section has no entries to release',
    );
  }
  const before = changelogText.slice(0, unreleasedMatch.index);
  const after = nextHeading === -1 ? "" : rest.slice(nextHeading);
  const tail = after.endsWith("\n") || after === "" ? after : `${after}\n`;
  return `${before}## Unreleased\n\n## ${version} - ${date}\n\n${body}\n\n${tail}`;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function abort(message: string): never {
  console.error(`cut-release: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith("--"));
  const push = args.includes("--push");
  const anyBranch = args.includes("--any-branch");
  if (!input || args.includes("--help")) {
    console.log(
      "Usage: bun scripts/cut-release.ts <X.Y.Z | patch | minor | major> [--push] [--any-branch]",
    );
    process.exit(input ? 0 : 1);
  }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main" && !anyBranch) {
    abort(
      `on branch "${branch}"; releases are cut from main (pass --any-branch to override)`,
    );
  }
  const dirty = git("status", "--porcelain", "--", ...RELEASE_FILES);
  if (dirty) {
    abort(
      `release files have uncommitted changes, commit or stash them first:\n${dirty}`,
    );
  }

  const current = parsePackageVersion(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  );
  const version = resolveNextVersion(current, input);
  const tag = `v${version}`;

  try {
    git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
    abort(`tag ${tag} already exists locally`);
  } catch {
    // Tag does not exist yet.
  }
  if (push && git("ls-remote", "--tags", "origin", tag)) {
    abort(`tag ${tag} already exists on origin`);
  }

  const date = new Date().toISOString().slice(0, 10);
  // Compute every output before writing anything so a validation failure
  // leaves the worktree untouched.
  const packageWrites = PACKAGE_FILES.map((file) => {
    const path = join(REPO_ROOT, file);
    const text = readFileSync(path, "utf8");
    return {
      path,
      text: replacePackageVersion(text, parsePackageVersion(text), version),
    };
  });
  const changelogPath = join(REPO_ROOT, CHANGELOG_FILE);
  const changelogWrite = rotateChangelog(
    readFileSync(changelogPath, "utf8"),
    version,
    date,
  );
  for (const { path, text } of packageWrites) {
    writeFileSync(path, text);
  }
  writeFileSync(changelogPath, changelogWrite);

  git("add", ...RELEASE_FILES);
  git("commit", "-m", `Release ${version}`);
  git("tag", "-a", tag, "-m", `herdr-gui ${version}`);
  console.log(`Created release commit and tag ${tag} (version ${version}).`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=${tag}\n`,
    );
  }

  if (push) {
    git("push", "origin", `HEAD:${branch}`);
    git("push", "origin", tag);
    console.log(
      `Pushed ${branch} and ${tag}. The Release workflow builds and publishes the archives.`,
    );
  } else {
    console.log(
      `Not pushed. When ready: git push origin HEAD:${branch} && git push origin ${tag}`,
    );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    abort(error instanceof Error ? error.message : String(error));
  }
}
