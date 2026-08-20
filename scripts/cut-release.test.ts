import { describe, expect, test } from "bun:test";
import { extractChangelogSection } from "./changelog-notes";
import {
  parsePackageVersion,
  replacePackageVersion,
  resolveNextVersion,
  rotateChangelog,
} from "./cut-release";

const PACKAGE_JSON = `{
  "name": "herdr-gui",
  "private": true,
  "version": "0.4.1",
  "scripts": {
    "test": "bun test"
  }
}
`;

const CHANGELOG = `# Changelog

## Unreleased

### Added

- Shiny new feature.

### Fixed

- Important fix.

## 0.4.1 - 2026-08-20

### Changed

- Previous release entry.

## 0.4.0 - 2026-08-20

- Older entry.
`;

describe("parsePackageVersion", () => {
  test("reads the top-level version", () => {
    expect(parsePackageVersion(PACKAGE_JSON)).toBe("0.4.1");
  });

  test("rejects package.json without a version", () => {
    expect(() => parsePackageVersion(`{ "name": "x" }`)).toThrow("version");
  });
});

describe("replacePackageVersion", () => {
  test("replaces only the version line and preserves the rest", () => {
    const next = replacePackageVersion(PACKAGE_JSON, "0.4.1", "0.4.2");
    expect(parsePackageVersion(next)).toBe("0.4.2");
    expect(next).toBe(
      PACKAGE_JSON.replace('"version": "0.4.1"', '"version": "0.4.2"'),
    );
  });

  test("rejects an unexpected current version", () => {
    expect(() => replacePackageVersion(PACKAGE_JSON, "9.9.9", "0.4.2")).toThrow(
      "expected",
    );
  });
});

describe("resolveNextVersion", () => {
  test("supports patch, minor, and major keywords", () => {
    expect(resolveNextVersion("0.4.1", "patch")).toBe("0.4.2");
    expect(resolveNextVersion("0.4.1", "minor")).toBe("0.5.0");
    expect(resolveNextVersion("0.4.1", "major")).toBe("1.0.0");
  });

  test("accepts an explicit version greater than the current one", () => {
    expect(resolveNextVersion("0.4.1", "0.4.10")).toBe("0.4.10");
    expect(resolveNextVersion("0.4.1", "0.5.0")).toBe("0.5.0");
  });

  test("rejects versions that are not greater than the current one", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4.1")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.3.9")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.4.0")).toThrow("greater");
  });

  test("rejects malformed input", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "next")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4", "patch")).toThrow("X.Y.Z");
  });
});

describe("rotateChangelog", () => {
  test("moves the Unreleased entries under a dated version heading", () => {
    const next = rotateChangelog(CHANGELOG, "0.4.2", "2026-08-21");
    expect(next).toContain("## Unreleased\n\n## 0.4.2 - 2026-08-21\n");
    expect(next).toContain(
      "## 0.4.2 - 2026-08-21\n\n### Added\n\n- Shiny new feature.\n\n### Fixed\n\n- Important fix.\n\n## 0.4.1 - 2026-08-20",
    );
    expect(next).toContain("## 0.4.0 - 2026-08-20");
  });

  test("handles Unreleased as the last section", () => {
    const text = "# Changelog\n\n## Unreleased\n\n- Only entry.\n";
    const next = rotateChangelog(text, "1.0.0", "2026-08-21");
    expect(next).toBe(
      "# Changelog\n\n## Unreleased\n\n## 1.0.0 - 2026-08-21\n\n- Only entry.\n\n",
    );
  });

  test("rejects an empty Unreleased section", () => {
    const text =
      "# Changelog\n\n## Unreleased\n\n## 0.4.1 - 2026-08-20\n\n- Old.\n";
    expect(() => rotateChangelog(text, "0.4.2", "2026-08-21")).toThrow(
      "no entries",
    );
  });

  test("rejects a duplicate version section", () => {
    expect(() => rotateChangelog(CHANGELOG, "0.4.1", "2026-08-21")).toThrow(
      "already has a section",
    );
  });

  test("rejects a changelog without an Unreleased section", () => {
    expect(() =>
      rotateChangelog(
        "# Changelog\n\n## 0.4.1\n\n- Old.\n",
        "0.4.2",
        "2026-08-21",
      ),
    ).toThrow("Unreleased");
  });
});

describe("extractChangelogSection", () => {
  test("extracts a middle section without the heading", () => {
    expect(extractChangelogSection(CHANGELOG, "0.4.1")).toBe(
      "### Changed\n\n- Previous release entry.",
    );
  });

  test("extracts the final section", () => {
    expect(extractChangelogSection(CHANGELOG, "0.4.0")).toBe("- Older entry.");
  });

  test("rejects missing or empty sections", () => {
    expect(() => extractChangelogSection(CHANGELOG, "9.9.9")).toThrow(
      "no section",
    );
    const text = "# Changelog\n\n## 0.4.2 - 2026-08-21\n\n## 0.4.1\n\n- Old.\n";
    expect(() => extractChangelogSection(text, "0.4.2")).toThrow("empty");
  });
});
