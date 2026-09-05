import { stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";

const repositoryRoot = "https://github.com/powerfooI/herdr-studio/blob/main/";

export interface TutorialPage {
  content: string;
  navigation: string;
}

/** Render trusted repository Markdown; this is not an untrusted-content sanitizer. */
export async function renderTutorial(markdown: string): Promise<TutorialPage> {
  const navigation: string[] = [];
  let chapter = 0;
  let section = 0;
  // Explicit source anchors remain usable on both GitHub and Pages. Generated
  // heading IDs stay stable when titles are reworded.
  const html = Bun.markdown
    .html(markdown)
    .replace(/<h([1-3])>(.*?)<\/h\1>/g, (_, level: string, title: string) => {
      let id = "tutorial-title";
      if (level === "2") {
        id = `chapter-${++chapter}`;
        navigation.push(`<li><a href="#${id}">${title}</a></li>`);
      } else if (level === "3") {
        id = `section-${++section}`;
      }
      return `<h${level} id="${id}">${title}</h${level}>`;
    });

  const content = await new HTMLRewriter()
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href") ?? "";
        if (!href.startsWith(".")) return;
        // Keep installation/security references canonical instead of copying
        // those documents into the tutorial or depending on a site-root path.
        element.setAttribute(
          "href",
          new URL(href, `${repositoryRoot}docs/`).href,
        );
      },
    })
    .on("img", {
      async element(element) {
        const src = element.getAttribute("src") ?? "";
        if (src.startsWith("./images/")) {
          const name = posix.basename(src);
          const header = Buffer.from(
            await Bun.file(new URL(`../docs/images/${name}`, import.meta.url))
              .slice(0, 24)
              .arrayBuffer(),
          );
          if (
            header.length < 24 ||
            header.toString("hex", 0, 8) !== "89504e470d0a1a0a"
          ) {
            throw new Error(`Expected a shared PNG screenshot: ${name}`);
          }
          // Reserve the real aspect ratio before lazy images load; otherwise
          // jumping to a chapter can land above it after layout shifts.
          element.setAttribute("width", String(header.readUInt32BE(16)));
          element.setAttribute("height", String(header.readUInt32BE(20)));
          element.setAttribute("src", `../assets/${name}`);
        }
        element.setAttribute("loading", "lazy");
        element.setAttribute("decoding", "async");
      },
    })
    .on("table", {
      element(element) {
        element.before(
          '<div class="tutorial-table" role="region" aria-label="Horizontally scrollable reference table" tabindex="0">',
          { html: true },
        );
        element.after("</div>", { html: true });
      },
    })
    .transform(new Response(html))
    .text();

  return { content, navigation: `<ol>${navigation.join("")}</ol>` };
}

/** Return page-relative assets and links, including srcset candidates. */
export function localPageReferences(html: string): string[] {
  const references = [...html.matchAll(/(?:href|src)="([^"\s]+)"/g)].map(
    (match) => match[1],
  );
  for (const match of html.matchAll(/srcset="([^"]+)"/gs)) {
    references.push(
      ...match[1]
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
        .filter(Boolean),
    );
  }
  for (const reference of references) {
    if (reference.startsWith("/")) {
      throw new Error(
        `Root-relative site reference breaks on the GitHub Pages subpath: ${reference}`,
      );
    }
  }
  return [...new Set(references)].filter(
    (reference) => !/^[a-z][a-z\d+.-]*:/i.test(reference),
  );
}

/** Fail the Pages build on broken assets, cross-page links, or fragments. */
export async function verifySiteReferences(directory: string): Promise<void> {
  const root = resolve(directory);
  const pages = new Map<string, Set<string>>();
  for await (const path of new Bun.Glob("**/*.html").scan(root)) {
    const absolute = join(root, path);
    const html = await Bun.file(absolute).text();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Duplicate HTML IDs in ${path}`);
    }
    pages.set(absolute, new Set(ids));
  }
  for (const page of pages.keys()) {
    const html = await Bun.file(page).text();
    for (const reference of localPageReferences(html)) {
      const [location, fragment] = reference.split("#", 2);
      const pathname = decodeURIComponent(location.split("?", 1)[0]);
      let target = pathname ? resolve(dirname(page), pathname) : page;
      if (relative(root, target).startsWith("..")) {
        throw new Error(`Site reference escapes output: ${reference}`);
      }
      const entry = await stat(target).catch(() => null);
      if (!entry) {
        throw new Error(`Missing site reference in ${page}: ${reference}`);
      }
      if (entry.isDirectory()) target = join(target, "index.html");
      if (!(await stat(target)).isFile()) {
        throw new Error(`Expected a site file: ${target}`);
      }
      if (
        fragment &&
        pages.has(target) &&
        !pages.get(target)?.has(decodeURIComponent(fragment))
      ) {
        throw new Error(`Missing fragment in ${page}: ${reference}`);
      }
    }
  }
}
