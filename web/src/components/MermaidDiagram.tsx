import { useEffect, useState } from "react";
import { loadMermaidModule, renderMermaidDiagram } from "../mermaidRender";

type MermaidDiagramState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; error: string }
  | { kind: "svg"; svg: string };

export function MermaidDiagram({
  code,
  className = "",
}: {
  code: string;
  className?: string;
}) {
  const [state, setState] = useState<MermaidDiagramState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) {
      setState({ kind: "empty" });
      return () => {
        cancelled = true;
      };
    }
    setState({ kind: "loading" });
    void loadMermaidModule().then(
      (mermaid) => {
        if (cancelled) return;
        const rendered = renderMermaidDiagram(mermaid, code);
        setState(
          rendered.ok
            ? { kind: "svg", svg: rendered.svg }
            : { kind: "error", error: rendered.error },
        );
      },
      (error) => {
        if (cancelled) return;
        setState({
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.kind === "loading") {
    return (
      <div
        className={`mermaid-diagram is-loading ${className}`.trim()}
        role="status"
        aria-live="polite"
      >
        <span className="file-loading-spinner" />
        Rendering diagram
      </div>
    );
  }
  if (state.kind === "empty") {
    return (
      <div className={`mermaid-diagram is-empty ${className}`.trim()}>
        Empty diagram
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className={`mermaid-diagram-error ${className}`.trim()} role="alert">
        Mermaid render failed: {state.error}
      </div>
    );
  }
  return (
    <div
      className={`mermaid-diagram ${className}`.trim()}
      role="img"
      aria-label="Mermaid diagram"
      // SVG produced by beautiful-mermaid from escaped labels; the shared
      // module promise keeps it identical to the Markdown preview output.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
