import { describe, expect, test } from "bun:test";
import type { RenderOptions } from "beautiful-mermaid";
import { prepareMermaidSvg, renderMermaidDiagram } from "./mermaidRender";

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50" style="--bg:#000;--fg:#fff">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap');
  text { font-family: 'Inter', system-ui, sans-serif; }
  svg { --_text: var(--fg); }
</style>
<defs>
  <marker id="arrowhead" markerWidth="8" markerHeight="5" refX="7" refY="2.5" orient="auto">
    <polygon points="0 0, 8 2.5, 0 5" fill="var(--_arrow)" />
  </marker>
</defs>
<polyline class="edge" data-from="A" data-to="B" points="1,2 3,4" fill="none" stroke="var(--_line)" marker-end="url(#arrowhead)" />
<g class="node" data-id="A" id="A"><text>A</text></g>
<g class="node" data-id="B" id="B"><text>&lt;img src=x onerror=alert(1)&gt;</text></g>
<style type="text/css">
  svg { --_chart-grid: var(--_inner-stroke); }
</style>
</svg>`;

describe("prepareMermaidSvg", () => {
  test("strips the document-global style block", () => {
    const prepared = prepareMermaidSvg(SAMPLE_SVG, "mmd-7");
    expect(prepared).not.toContain("<style");
    expect(prepared).not.toContain("fonts.googleapis.com");
  });

  test("namespaces ids and marker references so diagrams cannot collide", () => {
    const prepared = prepareMermaidSvg(SAMPLE_SVG, "mmd-7");
    expect(prepared).toContain('id="mmd-7-arrowhead"');
    expect(prepared).toContain("url(#mmd-7-arrowhead)");
    expect(prepared).toContain('id="mmd-7-A"');
    expect(prepared).toContain('id="mmd-7-B"');
    expect(prepared).not.toContain(' id="A"');
    // Attribute-only lookalikes stay untouched.
    expect(prepared).toContain('data-id="A"');
  });
});

describe("renderMermaidDiagram", () => {
  test("renders with theme variables and a unique token", () => {
    let seenOptions: RenderOptions | undefined;
    const mermaid = {
      renderMermaidSVG(_code: string, options?: RenderOptions) {
        seenOptions = options;
        return SAMPLE_SVG;
      },
    };
    const first = renderMermaidDiagram(mermaid, "graph LR\n  A --> B");
    const second = renderMermaidDiagram(mermaid, "graph LR\n  A --> B");
    expect(seenOptions).toMatchObject({
      bg: "var(--viewer-code-bg)",
      fg: "var(--text)",
      line: "var(--accent)",
      transparent: true,
    });
    if (!first.ok || !second.ok) throw new Error("expected rendered svgs");
    expect(first.svg).toContain("<svg");
    const firstToken = first.svg.match(/id="(mmd-\d+)-arrowhead"/)?.[1];
    const secondToken = second.svg.match(/id="(mmd-\d+)-arrowhead"/)?.[1];
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);
  });

  test("reports renderer failures without throwing", () => {
    const mermaid = {
      renderMermaidSVG() {
        throw new Error('Invalid mermaid header: "junk"');
      },
    };
    const result = renderMermaidDiagram(mermaid, "junk");
    expect(result).toEqual({
      ok: false,
      error: 'Invalid mermaid header: "junk"',
    });
  });
});
