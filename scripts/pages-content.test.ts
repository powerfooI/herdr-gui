import { afterEach, describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localPageReferences,
  renderTutorial,
  verifySiteReferences,
} from "./pages-content";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-pages-test-"));
  temporaryDirectories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return directory;
}

describe("tutorial Markdown", () => {
  test("keeps the public tutorial content and reading controls in English", async () => {
    const [markdown, template, controls] = await Promise.all(
      [
        "../docs/TUTORIAL.md",
        "../site/tutorial/index.html",
        "../site/tutorial.js",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    );
    const { content } = await renderTutorial(markdown);
    expect(template).toContain('<html lang="en">');
    expect(content).toContain(
      "From your first terminal to a workspace that travels",
    );
    expect(controls).toContain('button.textContent = "Copy command"');
    expect(controls).toContain("Self-check:");
    expect([content, template, controls].join("\n")).not.toMatch(
      /\p{Script=Han}/u,
    );
  });

  test("renders tutorial headings with stable unique IDs and a five-chapter TOC", async () => {
    const markdown = await Bun.file(
      new URL("../docs/TUTORIAL.md", import.meta.url),
    ).text();
    const { content, navigation } = await renderTutorial(markdown);
    expect(content).toContain('id="tutorial-title"');
    expect(content.match(/<h2 /g)).toHaveLength(5);
    expect(navigation.match(/<li>/g)).toHaveLength(5);
    expect(navigation).toContain('href="#chapter-5"');
    const ids = [...content.matchAll(/\bid="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(ids).not.toContain("");
    expect(new Set(ids).size).toBe(ids.length);
    for (const anchor of ["tailscale", "tailcat", "ssh", "troubleshooting"]) {
      expect(ids).toContain(anchor);
    }
  });

  test("rewrites images and canonical docs, preserves code and source anchors", async () => {
    const { content } = await renderTutorial(
      '# Tutorial\n\n<a id="tailscale"></a>\n\n## Networking\n\n' +
        "[Jump](#tailscale) [Deployment](./DEPLOYMENT.md#logging) [Security](../SECURITY.md)\n\n" +
        "![Terminal](./images/herdr-studio-desktop-terminal.png)\n\n```bash\necho '<safe>'\n```\n\n" +
        "| Name | Purpose |\n| --- | --- |\n| Serve | Private access |\n",
    );
    expect(content).toContain('href="#tailscale"');
    expect(content).toContain(
      'href="https://github.com/powerfooI/herdr-studio/blob/main/docs/DEPLOYMENT.md#logging"',
    );
    expect(content).toContain(
      'href="https://github.com/powerfooI/herdr-studio/blob/main/SECURITY.md"',
    );
    expect(content).toContain(
      'src="../assets/herdr-studio-desktop-terminal.png"',
    );
    expect(content).toContain('width="4990"');
    expect(content).toContain('height="2820"');
    expect(content).toContain('loading="lazy"');
    expect(content).toContain("&lt;safe&gt;");
    expect(content).toContain('role="region"');
    expect(content).toContain(
      'aria-label="Horizontally scrollable reference table"',
    );
    expect(content).not.toContain("<safe>");
  });
});

describe("Pages references", () => {
  test("collects relative links and responsive images without external URLs", () => {
    expect(
      localPageReferences(
        '<a href="./tutorial/">Read</a><a href="#top">Top</a>' +
          '<a href="https://example.com">External</a>' +
          '<img src="../assets/a.png" srcset="../assets/a.png 1x, ../assets/b.png 2x">',
      ),
    ).toEqual(["./tutorial/", "#top", "../assets/a.png", "../assets/b.png"]);
  });

  test("rejects root-relative assets and protocol-relative links", () => {
    expect(() => localPageReferences('<img src="/assets/a.png">')).toThrow(
      "Root-relative",
    );
    expect(() => localPageReferences('<a href="//example.com">')).toThrow(
      "Root-relative",
    );
  });

  test("validates nested Pages routes, fragments, and parent-relative assets", async () => {
    const directory = await fixture({
      "index.html":
        '<h1 id="top">Home</h1><a href="./tutorial/#chapter-1">Read</a>',
      "tutorial/index.html":
        '<h1 id="chapter-1">Read</h1><a href="../index.html#top">Home</a>' +
        '<a href="#chapter-1">Start</a><img src="../assets/a.png?v=1">',
      "assets/a.png": "test fixture",
    });
    expect(await verifySiteReferences(directory)).toBeUndefined();
  });

  test("detects missing references inside nested pages", async () => {
    const directory = await fixture({
      "index.html": '<a href="./tutorial/">Read</a>',
      "tutorial/index.html": '<img src="../assets/missing.png">',
    });
    await rejects(verifySiteReferences(directory), /Missing site reference/);
  });

  test("detects broken cross-page fragments", async () => {
    const directory = await fixture({
      "index.html": '<a href="./tutorial/#missing">Read</a>',
      "tutorial/index.html": '<h1 id="present">Read</h1>',
    });
    await rejects(verifySiteReferences(directory), /Missing fragment/);
  });

  test("detects duplicate IDs", async () => {
    const directory = await fixture({
      "index.html": '<h1 id="same">Home</h1><h2 id="same">Read</h2>',
    });
    await rejects(verifySiteReferences(directory), /Duplicate HTML IDs/);
  });

  test("rejects a reference that escapes the built site", async () => {
    const directory = await fixture({
      "index.html": '<a href="../private.txt">Outside</a>',
    });
    await rejects(verifySiteReferences(directory), /escapes output/);
  });
});
