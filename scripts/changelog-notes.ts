#!/usr/bin/env bun
// Print the CHANGELOG section for a released version; used as the body of the
// GitHub release notes.
//
// Usage: bun scripts/changelog-notes.ts <X.Y.Z>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = fileURLToPath(
  new URL(join("..", "CHANGELOG.md"), import.meta.url),
);

export function extractChangelogSection(
  changelogText: string,
  version: string,
): string {
  const heading = new RegExp(
    `^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( .*)?$`,
    "m",
  ).exec(changelogText);
  if (!heading || heading.index === undefined) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  const rest = changelogText.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^## /m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section for ${version} is empty`);
  }
  return body;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: bun scripts/changelog-notes.ts <X.Y.Z>");
    process.exit(1);
  }
  console.log(
    extractChangelogSection(readFileSync(CHANGELOG_PATH, "utf8"), version),
  );
}
