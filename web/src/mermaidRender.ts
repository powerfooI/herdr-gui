/**
 * Mermaid diagram rendering backed by beautiful-mermaid. The renderer and its
 * layout engine are lazily code-split so the main bundle stays small; both
 * file previews and Markdown code fences share the cached module promise.
 */

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

type MermaidModule = typeof import("beautiful-mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;

export function loadMermaidModule(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("beautiful-mermaid");
  return mermaidModulePromise;
}

let mermaidDiagramCounter = 0;

/**
 * Rewrites renderer output for safe inline embedding:
 * - drops the bundled <style> block, whose bare `svg`/`text` selectors and
 *   Google Fonts @import would leak into the whole document (the scoped
 *   replacement lives in styles.css under .mermaid-diagram);
 * - prefixes svg-internal ids so multiple diagrams on one page cannot share
 *   `arrowhead`/node ids and cross-reference each other's markers.
 */
export function prepareMermaidSvg(svg: string, token: string): string {
  let result = svg.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  const ids = new Set(
    Array.from(result.matchAll(/\sid="([^"]+)"/g), (match) => match[1]),
  );
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(`(\\s)id="${escaped}"`, "g"), `$1id="${token}-${id}"`)
      .split(`url(#${id})`)
      .join(`url(#${token}-${id})`);
  }
  return result;
}

export function renderMermaidDiagram(
  mermaid: Pick<MermaidModule, "renderMermaidSVG">,
  code: string,
): MermaidRenderResult {
  try {
    const svg = mermaid.renderMermaidSVG(code, {
      // Reference app theme variables so light/dark switches apply without a
      // re-render. Diagram labels are XML-escaped by the renderer.
      bg: "var(--viewer-code-bg)",
      fg: "var(--text)",
      line: "var(--accent)",
      transparent: true,
    });
    mermaidDiagramCounter += 1;
    return {
      ok: true,
      svg: prepareMermaidSvg(svg, `mmd-${mermaidDiagramCounter}`),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
