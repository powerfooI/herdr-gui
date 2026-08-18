import { describe, expect, test } from "bun:test";
import {
  findTerminalHttpLinks,
  sanitizeTerminalHttpUrl,
} from "./terminalLinks";

describe("terminal HTTP links", () => {
  test("stops before Unicode prose punctuation", () => {
    const input = "Visit https://baidu.com。 then continue";
    expect(findTerminalHttpLinks(input).map((link) => link.url)).toEqual([
      "https://baidu.com",
    ]);
    for (const punctuation of [
      "。",
      "（",
      "）",
      "「",
      "」",
      "【",
      "】",
      "“",
      "”",
      "，",
    ]) {
      expect(
        sanitizeTerminalHttpUrl("https://baidu.com" + punctuation + "后续文本"),
      ).toBe("https://baidu.com");
    }
  });

  test("stops before zero-width and control characters", () => {
    expect(sanitizeTerminalHttpUrl("https://example.com\u200bhidden")).toBe(
      "https://example.com",
    );
    expect(sanitizeTerminalHttpUrl("https://example.com\u001b[31m")).toBe(
      "https://example.com",
    );
  });

  test("removes trailing ASCII prose punctuation", () => {
    expect(sanitizeTerminalHttpUrl("https://example.com/path!?")).toBe(
      "https://example.com/path",
    );
  });

  test("stops before unmatched ASCII opening delimiters", () => {
    const input =
      "MR !1205:https://git.example.com/acme/project/-/merge_requests/1205(commit e649debf)";
    expect(findTerminalHttpLinks(input).map((link) => link.url)).toEqual([
      "https://git.example.com/acme/project/-/merge_requests/1205",
    ]);
    expect(
      sanitizeTerminalHttpUrl("https://example.com/path[commit details"),
    ).toBe("https://example.com/path");
  });

  test("keeps normal URL path, query, fragment, and percent encoding", () => {
    expect(
      sanitizeTerminalHttpUrl(
        "https://example.com/a%20b?q=hello&lang=en#result",
      ),
    ).toBe("https://example.com/a%20b?q=hello&lang=en#result");
    expect(sanitizeTerminalHttpUrl("https://example.com/中文路径")).toBe(
      "https://example.com/中文路径",
    );
  });

  test("keeps balanced delimiters and IPv6 addresses", () => {
    expect(
      sanitizeTerminalHttpUrl("https://example.com/wiki/Function_(math)"),
    ).toBe("https://example.com/wiki/Function_(math)");
    expect(sanitizeTerminalHttpUrl("http://[::1]:8787/path")).toBe(
      "http://[::1]:8787/path",
    );
    expect(sanitizeTerminalHttpUrl("https://example.com/path) next")).toBe(
      "https://example.com/path",
    );
  });

  test("does not detect a URL embedded in another identifier", () => {
    expect(findTerminalHttpLinks("abchttps://example.com")).toEqual([]);
    expect(
      findTerminalHttpLinks("(https://one.example)。https://two.example").map(
        (link) => link.url,
      ),
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  test("rejects unsupported or incomplete destinations", () => {
    expect(sanitizeTerminalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeTerminalHttpUrl("https://")).toBeNull();
  });
});
