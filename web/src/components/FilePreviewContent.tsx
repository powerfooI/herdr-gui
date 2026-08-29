import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import type { FileExplorerEntry, FilePreview } from "../types";
import { useConnectionClient } from "../useConnectionClient";
import {
  resolveWorkspaceMarkdownImageUrl,
  workspaceFileUrl,
} from "../workspaceFileUrl";
import { MarkdownPreview } from "./markdown";
import { MermaidDiagram } from "./MermaidDiagram";
import { highlightCodeTokens } from "./syntaxHighlighting";

export type ActiveFilePreviewSelection = {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
};

export type FilePreviewSelectionMeta = {
  userInitiated?: boolean;
};

type AppTheme = "dark" | "light";

const PDF_INLINE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

type CodeMirrorPreviewDeps = Awaited<
  ReturnType<typeof importCodeMirrorPreviewDeps>
>;

let codeMirrorPreviewDepsPromise: Promise<CodeMirrorPreviewDeps> | null = null;

async function importCodeMirrorPreviewDeps() {
  const [codemirror, state, view, searchModule] = await Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/search"),
  ]);

  return {
    basicSetup: codemirror.basicSetup,
    Compartment: state.Compartment,
    Decoration: view.Decoration,
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    keymap: view.keymap,
    openSearchPanel: searchModule.openSearchPanel,
    search: searchModule.search,
    searchKeymap: searchModule.searchKeymap,
  };
}

function loadCodeMirrorPreviewDeps() {
  codeMirrorPreviewDepsPromise ??= importCodeMirrorPreviewDeps();
  return codeMirrorPreviewDepsPromise;
}

function openPreviewSearch(view: CodeMirrorEditorView | null) {
  if (!view) return;
  void loadCodeMirrorPreviewDeps().then((deps) => deps.openSearchPanel(view));
}

function isMarkdownPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkdn")
  );
}

function isMermaidPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".mmd") || lower.endsWith(".mermaid");
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(currentDocumentTheme()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function isEditablePreviewTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".cm-editor")) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function FilePreviewContent({
  entry,
  preview,
  loading,
  error,
  changesContent,
  changesKey,
  onOpenChanges,
}: {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  changesContent?: ReactNode;
  changesKey?: string;
  onOpenChanges?: () => void;
}) {
  const connectionClient = useConnectionClient();
  const previewSectionRef = useRef<HTMLElement | null>(null);
  const editorViewRef = useRef<CodeMirrorEditorView | null>(null);
  const onOpenChangesRef = useRef(onOpenChanges);
  onOpenChangesRef.current = onOpenChanges;
  const [previewMode, setPreviewMode] = useState<"rendered" | "raw">(
    "rendered",
  );
  const [detailTab, setDetailTab] = useState<"file" | "changes">("file");
  const theme = useDocumentTheme();
  const previewText = preview?.text ?? null;
  const previewPath = preview?.path ?? "";
  const hasPreviewText = previewText !== null;
  const hasMarkdownPreview = hasPreviewText && isMarkdownPath(previewPath);
  const hasMermaidPreview = hasPreviewText && isMermaidPath(previewPath);
  const hasPdfPreview = Boolean(preview && isPdfPath(previewPath));
  const pdfTooLarge =
    hasPdfPreview && (preview?.size ?? 0) > PDF_INLINE_PREVIEW_MAX_BYTES;
  const hasRichPreview = hasMarkdownPreview || hasMermaidPreview;
  const renderRichPreview = hasRichPreview && previewMode === "rendered";
  const inlinePreviewUrl = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return null;
    return workspaceFileUrl(
      connectionClient,
      preview.workspace_id,
      previewPath,
      { inline: true, revision: preview.resource_revision },
    );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const markdownImageUrlResolver = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return undefined;
    return (source: string) =>
      resolveWorkspaceMarkdownImageUrl(
        source,
        previewPath,
        connectionClient,
        preview.workspace_id,
        preview.resource_revision,
      );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const changesAvailable =
    changesContent !== undefined && !!changesKey && !!onOpenChanges;
  const showingChanges = detailTab === "changes" && changesAvailable;

  useEffect(() => {
    setPreviewMode("rendered");
  }, [previewPath]);

  useEffect(() => {
    if (detailTab === "changes" && changesAvailable) {
      onOpenChangesRef.current?.();
    }
  }, [changesAvailable, changesKey, detailTab]);

  useEffect(() => {
    if (showingChanges || !hasPreviewText || renderRichPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const section = previewSectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditablePreviewTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      openPreviewSearch(editorViewRef.current);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [hasPreviewText, renderRichPreview, showingChanges]);

  return (
    <section
      ref={previewSectionRef}
      className="file-preview"
      aria-label="File preview"
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          if (showingChanges || renderRichPreview) return;
          e.preventDefault();
          e.stopPropagation();
          openPreviewSearch(editorViewRef.current);
        }
      }}
    >
      <div className="file-preview-head">
        <div className="file-preview-title-row">
          <div className="file-preview-title" title={entry?.name}>
            {entry?.name ?? "Preview"}
          </div>
          <div className="file-preview-head-actions">
            {!showingChanges && hasRichPreview ? (
              <button
                type="button"
                className="file-preview-mode-toggle"
                onClick={() =>
                  setPreviewMode((mode) =>
                    mode === "rendered" ? "raw" : "rendered",
                  )
                }
              >
                {previewMode === "rendered" ? "Raw" : "Rendered"}
              </button>
            ) : null}
            {changesAvailable ? (
              <button
                type="button"
                className="file-preview-changes-toggle"
                aria-pressed={showingChanges}
                title={showingChanges ? "Show file preview" : "Show changes"}
                onClick={() =>
                  setDetailTab(showingChanges ? "file" : "changes")
                }
              >
                Changes
              </button>
            ) : null}
          </div>
        </div>
        {entry ? <span>{entry.path}</span> : null}
      </div>

      {showingChanges ? (
        <div
          className="file-preview-changes"
          role="region"
          aria-label={`Changes for ${entry?.name ?? "selected file"}`}
        >
          {changesContent}
        </div>
      ) : (
        <div
          className="file-preview-file-content"
          role="region"
          aria-label={`Preview of ${entry?.name ?? "selected file"}`}
        >
          {!entry ? (
            <div className="file-preview-state">
              Select a text file to preview.
            </div>
          ) : null}
          {loading ? (
            <div className="file-preview-state">
              <span className="file-loading-spinner" />
              Loading preview
            </div>
          ) : null}
          {error ? (
            <div className="file-preview-state is-error">{error}</div>
          ) : null}
          {!loading && !error && preview?.image_data_url ? (
            <div className="file-preview-image-wrap">
              <img
                className="file-preview-image"
                src={preview.image_data_url}
                alt={entry?.name ?? preview.path}
              />
            </div>
          ) : null}
          {!loading &&
          !error &&
          hasPdfPreview &&
          !pdfTooLarge &&
          inlinePreviewUrl ? (
            <iframe
              className="file-preview-pdf"
              src={inlinePreviewUrl}
              title={`PDF preview: ${entry?.name ?? previewPath}`}
            />
          ) : null}
          {!loading && !error && pdfTooLarge ? (
            <div className="file-preview-state">
              PDF is too large to preview. Use Download from the file menu.
            </div>
          ) : null}
          {!loading &&
          !error &&
          preview?.binary &&
          !preview.image_data_url &&
          !hasPdfPreview ? (
            <div className="file-preview-state">
              Binary file cannot be previewed.
            </div>
          ) : null}
          {!loading && !error && preview?.truncated && !hasPdfPreview ? (
            <div className="file-preview-banner">
              Preview truncated at 512 KB.
            </div>
          ) : null}
          {!loading && !error && hasMarkdownPreview && renderRichPreview ? (
            <MarkdownPreview
              text={previewText}
              imageUrlResolver={markdownImageUrlResolver}
            />
          ) : null}
          {!loading && !error && hasMermaidPreview && renderRichPreview ? (
            <MermaidDiagram
              code={previewText}
              className="file-preview-mermaid"
            />
          ) : null}
          {!loading &&
          !error &&
          hasPreviewText &&
          !renderRichPreview &&
          !hasPdfPreview ? (
            <CodeMirrorPreview
              text={previewText}
              path={previewPath}
              theme={theme}
              editorViewRef={editorViewRef}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function CodeMirrorPreview({
  text,
  path,
  theme,
  editorViewRef,
}: {
  text: string;
  path: string;
  theme: AppTheme;
  editorViewRef: MutableRefObject<CodeMirrorEditorView | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    let cancelled = false;
    let view: CodeMirrorEditorView | null = null;
    parent.textContent = "";

    void loadCodeMirrorPreviewDeps().then((deps) => {
      if (cancelled || !containerRef.current) return;
      parent.textContent = "";
      const syntaxCompartment = new deps.Compartment();
      view = new deps.EditorView({
        parent,
        state: deps.EditorState.create({
          doc: text,
          extensions: [
            deps.basicSetup,
            deps.search({ top: true }),
            deps.keymap.of(deps.searchKeymap),
            deps.EditorState.readOnly.of(true),
            deps.EditorView.editable.of(false),
            syntaxCompartment.of([]),
            deps.EditorView.theme(
              {
                "&": {
                  height: "100%",
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--text-code)",
                },
                ".cm-scroller": {
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "12px",
                  lineHeight: "1.55",
                },
                ".cm-content": {
                  caretColor: "var(--accent)",
                  padding: "10px 0",
                },
                ".cm-content ::selection": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  color: "inherit",
                },
                ".cm-line": {
                  padding: "0 12px",
                },
                ".cm-gutters": {
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--muted)",
                  borderRight: "1px solid var(--border-soft)",
                },
                ".cm-lineNumbers .cm-gutterElement": {
                  padding: "0 10px 0 12px",
                  minWidth: "42px",
                },
                ".cm-activeLineGutter, .cm-activeLine": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 10%, transparent)",
                },
                ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":
                  {
                    backgroundColor:
                      "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  },
                ".cm-cursor": {
                  borderLeftColor: "var(--accent)",
                },
                ".cm-panels, .cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                    color: "var(--text)",
                    borderColor: "var(--border-soft)",
                  },
                ".cm-panel.cm-search": {
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  backgroundColor: "var(--viewer-header-bg)",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search input":
                  {
                    height: "30px",
                    padding: "0 8px",
                    backgroundColor: "var(--viewer-code-bg)",
                    color: "var(--text)",
                    border: "1px solid var(--viewer-border)",
                    borderRadius: "7px",
                    outline: "none",
                  },
                ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-search input:focus":
                  {
                    borderColor: "var(--accent)",
                    boxShadow: "0 0 0 2px var(--accent-soft)",
                  },
                ".cm-panel.cm-search .cm-button, .cm-panel.cm-search button": {
                  height: "30px",
                  padding: "0 10px",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                  border: "1px solid var(--viewer-border)",
                  borderRadius: "7px",
                  backgroundImage: "none",
                  font: "inherit",
                },
                ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search button:hover":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                  },
                ".cm-panel.cm-search .cm-button:disabled, .cm-panel.cm-search button:disabled":
                  {
                    opacity: "0.48",
                  },
                ".cm-panel.cm-search label": {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search input[type=checkbox]": {
                  width: "16px",
                  height: "16px",
                  margin: "0",
                  padding: "0",
                  accentColor: "var(--accent)",
                },
                ".cm-searchMatch": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 36%, transparent)",
                  outline:
                    "1px solid color-mix(in srgb, var(--yellow) 45%, transparent)",
                },
                ".cm-searchMatch-selected": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 58%, transparent)",
                  color: "var(--text-strong)",
                  outline: "1px solid var(--yellow)",
                },
                ".cm-matchingBracket": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 18%, transparent)",
                  color: "var(--text-strong)",
                  outline:
                    "1px solid color-mix(in srgb, var(--accent) 38%, transparent)",
                },
                ".cm-nonmatchingBracket": {
                  backgroundColor: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  outline: "1px solid var(--danger-border)",
                },
                ".cm-foldPlaceholder": {
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--muted)",
                  border: "1px solid var(--viewer-border)",
                },
                ".cm-tooltip, .cm-tooltip.cm-tooltip-autocomplete": {
                  border: "1px solid var(--viewer-border)",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                },
              },
              { dark: theme === "dark" },
            ),
          ],
        }),
      });
      editorViewRef.current = view;
      const activeView = view;

      void highlightCodeTokens(text, path)
        .then((tokens) => {
          if (cancelled || view !== activeView) return;
          const decorations = deps.Decoration.set(
            tokens.map(({ from, to, className }) =>
              deps.Decoration.mark({ class: className }).range(from, to),
            ),
            true,
          );
          activeView.dispatch({
            effects: syntaxCompartment.reconfigure(
              deps.EditorView.decorations.of(decorations),
            ),
          });
        })
        .catch(() => {
          // Highlighting is progressive; the plain-text preview remains usable.
        });
    });

    return () => {
      cancelled = true;
      if (editorViewRef.current === view) editorViewRef.current = null;
      view?.destroy();
    };
  }, [editorViewRef, path, text, theme]);

  return (
    <div ref={containerRef} className="file-preview-code syntax-highlighted" />
  );
}
