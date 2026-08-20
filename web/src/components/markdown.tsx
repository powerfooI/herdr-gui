import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import { loadMermaidModule, renderMermaidDiagram } from "../mermaidRender";

const MARKDOWN_ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const MARKDOWN_ALLOWED_ATTRS = new Set([
  "alt",
  "checked",
  "colspan",
  "disabled",
  "href",
  "rowspan",
  "src",
  "title",
  "type",
]);
const MARKDOWN_DROP_CONTENT_TAGS = new Set([
  "iframe",
  "object",
  "script",
  "style",
]);

export function isSafeMarkdownUrl(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/);
  if (!protocolMatch) return true;
  return ["http:", "https:", "mailto:"].includes(protocolMatch[0]);
}

export function sanitizeMarkdownHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (MARKDOWN_DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!MARKDOWN_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    if (tag === "input") {
      const isCheckbox = element.getAttribute("type") === "checkbox";
      if (!isCheckbox) {
        element.remove();
        continue;
      }
      element.setAttribute("disabled", "");
    }

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name === "class" &&
        tag === "code" &&
        /^language-[a-z0-9#+.-]{1,40}$/i.test(attr.value.trim())
      ) {
        // Keep the fenced-code language hint so mermaid blocks can be found
        // and replaced with rendered diagrams after sanitization.
        continue;
      }
      if (
        name.startsWith("on") ||
        name === "style" ||
        !MARKDOWN_ALLOWED_ATTRS.has(name)
      ) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === "href" || name === "src") &&
        !isSafeMarkdownUrl(attr.value)
      ) {
        element.removeAttribute(attr.name);
      }
    }

    if (tag === "a" && element.hasAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  }

  return doc.body.innerHTML;
}

export function renderMarkdown(
  text: string,
  options: { breaks?: boolean } = {},
) {
  const html = marked.parse(text, {
    async: false,
    // Chat messages are not authored as strict markdown documents, so callers
    // rendering conversation text should opt into breaks to keep intentional
    // single newlines instead of collapsing them into one paragraph.
    breaks: options.breaks ?? false,
    gfm: true,
  });
  return sanitizeMarkdownHtml(String(html));
}

export function MarkdownPreview({
  text,
  className = "",
  breaks = false,
}: {
  text: string;
  className?: string;
  breaks?: boolean;
}) {
  const html = useMemo(() => renderMarkdown(text, { breaks }), [text, breaks]);
  const articleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const blocks = Array.from(
      root.querySelectorAll("pre > code.language-mermaid"),
    );
    if (blocks.length === 0) return;
    let cancelled = false;
    loadMermaidModule()
      .then((mermaid) => {
        if (cancelled) return;
        for (const codeElement of blocks) {
          const pre = codeElement.parentElement;
          if (!pre || pre.tagName !== "PRE" || !pre.isConnected) continue;
          const code = codeElement.textContent ?? "";
          if (!code.trim()) continue;
          const rendered = renderMermaidDiagram(mermaid, code);
          if (rendered.ok) {
            const figure = document.createElement("div");
            figure.className = "mermaid-diagram";
            figure.setAttribute("role", "img");
            figure.setAttribute("aria-label", "Mermaid diagram");
            figure.innerHTML = rendered.svg;
            pre.replaceWith(figure);
          } else {
            const note = document.createElement("div");
            note.className = "mermaid-diagram-error";
            note.textContent = `Mermaid render failed: ${rendered.error}`;
            pre.before(note);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <article
      ref={articleRef}
      className={`file-preview-markdown ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
