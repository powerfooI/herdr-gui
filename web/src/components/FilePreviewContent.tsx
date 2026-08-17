import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import type { FileExplorerEntry, FilePreview } from "../types";
import { MarkdownPreview } from "./markdown";

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

type CodeMirrorPreviewDeps = Awaited<ReturnType<typeof importCodeMirrorPreviewDeps>>;

let codeMirrorPreviewDepsPromise: Promise<CodeMirrorPreviewDeps> | null = null;

async function importCodeMirrorPreviewDeps() {
  const [
    codemirror,
    state,
    view,
    searchModule,
    language,
    highlight,
    javascriptModule,
    jsonModule,
    pythonModule,
    htmlModule,
    cssModule,
    markdownModule,
    javaModule,
    cppModule,
    goModule,
    rustModule,
    sqlModule,
    xmlModule,
    yamlModule,
    phpModule,
    sassModule,
    vueModule,
    shellModule,
    dockerFileModule,
    tomlModule,
    rubyModule,
    luaModule,
    perlModule,
    swiftModule,
    clojureModule,
    rModule,
    powerShellModule,
    legacyCssModule,
  ] = await Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/search"),
    import("@codemirror/language"),
    import("@lezer/highlight"),
    import("@codemirror/lang-javascript"),
    import("@codemirror/lang-json"),
    import("@codemirror/lang-python"),
    import("@codemirror/lang-html"),
    import("@codemirror/lang-css"),
    import("@codemirror/lang-markdown"),
    import("@codemirror/lang-java"),
    import("@codemirror/lang-cpp"),
    import("@codemirror/lang-go"),
    import("@codemirror/lang-rust"),
    import("@codemirror/lang-sql"),
    import("@codemirror/lang-xml"),
    import("@codemirror/lang-yaml"),
    import("@codemirror/lang-php"),
    import("@codemirror/lang-sass"),
    import("@codemirror/lang-vue"),
    import("@codemirror/legacy-modes/mode/shell"),
    import("@codemirror/legacy-modes/mode/dockerfile"),
    import("@codemirror/legacy-modes/mode/toml"),
    import("@codemirror/legacy-modes/mode/ruby"),
    import("@codemirror/legacy-modes/mode/lua"),
    import("@codemirror/legacy-modes/mode/perl"),
    import("@codemirror/legacy-modes/mode/swift"),
    import("@codemirror/legacy-modes/mode/clojure"),
    import("@codemirror/legacy-modes/mode/r"),
    import("@codemirror/legacy-modes/mode/powershell"),
    import("@codemirror/legacy-modes/mode/css"),
  ]);
  const t = highlight.tags;
  const filePreviewHighlightStyle = language.HighlightStyle.define([
    { tag: t.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
    { tag: [t.meta, t.documentMeta, t.processingInstruction], color: "var(--syntax-meta)" },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "var(--syntax-keyword)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function)" },
    { tag: [t.className, t.typeName, t.definition(t.typeName)], color: "var(--syntax-type)" },
    { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syntax-property)" },
    { tag: [t.variableName, t.namespace, t.macroName], color: "var(--syntax-variable)" },
    { tag: [t.operator, t.operatorKeyword, t.compareOperator], color: "var(--syntax-operator)" },
    { tag: [t.punctuation, t.separator, t.bracket], color: "var(--syntax-punctuation)" },
    { tag: [t.heading, t.strong], color: "var(--text-strong)", fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, color: "var(--blue)", textDecoration: "underline" },
  ]);

  return {
    basicSetup: codemirror.basicSetup,
    Compartment: state.Compartment,
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    keymap: view.keymap,
    openSearchPanel: searchModule.openSearchPanel,
    search: searchModule.search,
    searchKeymap: searchModule.searchKeymap,
    StreamLanguage: language.StreamLanguage,
    syntaxHighlighting: language.syntaxHighlighting,
    filePreviewHighlightStyle,
    javascript: javascriptModule.javascript,
    json: jsonModule.json,
    python: pythonModule.python,
    html: htmlModule.html,
    css: cssModule.css,
    markdown: markdownModule.markdown,
    java: javaModule.java,
    cpp: cppModule.cpp,
    go: goModule.go,
    rust: rustModule.rust,
    sql: sqlModule.sql,
    xml: xmlModule.xml,
    yaml: yamlModule.yaml,
    php: phpModule.php,
    sass: sassModule.sass,
    vue: vueModule.vue,
    shell: shellModule.shell,
    dockerFile: dockerFileModule.dockerFile,
    toml: tomlModule.toml,
    ruby: rubyModule.ruby,
    lua: luaModule.lua,
    perl: perlModule.perl,
    swift: swiftModule.swift,
    clojure: clojureModule.clojure,
    r: rModule.r,
    powerShell: powerShellModule.powerShell,
    less: legacyCssModule.less,
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

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentDocumentTheme()));
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
}: {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
}) {
  const previewSectionRef = useRef<HTMLElement | null>(null);
  const editorViewRef = useRef<CodeMirrorEditorView | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "raw">(
    "rendered",
  );
  const theme = useDocumentTheme();
  const previewText = preview?.text ?? null;
  const previewPath = preview?.path ?? "";
  const hasPreviewText = previewText !== null;
  const hasMarkdownPreview = hasPreviewText && isMarkdownPath(previewPath);
  const renderMarkdownPreview =
    hasMarkdownPreview && markdownMode === "rendered";

  useEffect(() => {
    setMarkdownMode("rendered");
  }, [previewPath]);

  useEffect(() => {
    if (!hasPreviewText || renderMarkdownPreview) return;
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
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [hasPreviewText, renderMarkdownPreview]);

  return (
    <section
      ref={previewSectionRef}
      className="file-preview"
      aria-label="File preview"
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          if (renderMarkdownPreview) return;
          e.preventDefault();
          e.stopPropagation();
          openPreviewSearch(editorViewRef.current);
        }
      }}
    >
      <div className="file-preview-head">
        <div className="file-preview-title-row">
          <strong>{entry?.name ?? "Preview"}</strong>
          {hasMarkdownPreview ? (
            <button
              type="button"
              className="file-preview-mode-toggle"
              onClick={() =>
                setMarkdownMode((mode) =>
                  mode === "rendered" ? "raw" : "rendered",
                )
              }
            >
              {markdownMode === "rendered" ? "Raw" : "Rendered"}
            </button>
          ) : null}
        </div>
        {entry ? <span>{entry.path}</span> : null}
      </div>

      {!entry ? (
        <div className="file-preview-state">Select a text file to preview.</div>
      ) : null}
      {loading ? (
        <div className="file-preview-state">
          <span className="file-loading-spinner" />
          Loading preview
        </div>
      ) : null}
      {error ? <div className="file-preview-state is-error">{error}</div> : null}
      {!loading && !error && preview?.image_data_url ? (
        <div className="file-preview-image-wrap">
          <img
            className="file-preview-image"
            src={preview.image_data_url}
            alt={entry?.name ?? preview.path}
          />
        </div>
      ) : null}
      {!loading && !error && preview?.binary && !preview.image_data_url ? (
        <div className="file-preview-state">Binary file cannot be previewed.</div>
      ) : null}
      {!loading && !error && preview?.truncated ? (
        <div className="file-preview-banner">Preview truncated at 512 KB.</div>
      ) : null}
      {!loading && !error && hasPreviewText && renderMarkdownPreview ? (
        <MarkdownPreview text={previewText} />
      ) : null}
      {!loading && !error && hasPreviewText && !renderMarkdownPreview ? (
        <CodeMirrorPreview
          text={previewText}
          path={previewPath}
          theme={theme}
          editorViewRef={editorViewRef}
        />
      ) : null}
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
      const languageCompartment = new deps.Compartment();
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
            languageCompartment.of([]),
            deps.syntaxHighlighting(deps.filePreviewHighlightStyle),
            deps.EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "var(--viewer-code-bg)",
                color: "var(--text-code)",
              },
              ".cm-scroller": {
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "12px",
                lineHeight: "1.55",
              },
              ".cm-content": {
                caretColor: "var(--accent)",
                padding: "10px 0",
              },
              ".cm-content ::selection": {
                backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent) !important",
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
                backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
              },
              ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
                backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent) !important",
              },
              ".cm-cursor": {
                borderLeftColor: "var(--accent)",
              },
              ".cm-panels, .cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom": {
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
              ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search input": {
                height: "30px",
                padding: "0 8px",
                backgroundColor: "var(--viewer-code-bg)",
                color: "var(--text)",
                border: "1px solid var(--viewer-border)",
                borderRadius: "7px",
                outline: "none",
              },
              ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-search input:focus": {
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
              ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search button:hover": {
                backgroundColor: "var(--viewer-header-bg)",
              },
              ".cm-panel.cm-search .cm-button:disabled, .cm-panel.cm-search button:disabled": {
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
                backgroundColor: "color-mix(in srgb, var(--yellow) 36%, transparent)",
                outline: "1px solid color-mix(in srgb, var(--yellow) 45%, transparent)",
              },
              ".cm-searchMatch-selected": {
                backgroundColor: "color-mix(in srgb, var(--yellow) 58%, transparent)",
                color: "var(--text-strong)",
                outline: "1px solid var(--yellow)",
              },
              ".cm-matchingBracket": {
                backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
                color: "var(--text-strong)",
                outline: "1px solid color-mix(in srgb, var(--accent) 38%, transparent)",
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
            }, { dark: theme === "dark" }),
          ],
        }),
      });
      editorViewRef.current = view;

      const language = codeMirrorLanguageForPath(path, deps);
      if (language) {
        view.dispatch({
          effects: languageCompartment.reconfigure(language),
        });
      }
    });

    return () => {
      cancelled = true;
      if (editorViewRef.current === view) editorViewRef.current = null;
      view?.destroy();
    };
  }, [editorViewRef, path, text, theme]);

  return <div ref={containerRef} className="file-preview-code" />;
}

function codeMirrorLanguageForPath(
  path: string,
  deps: CodeMirrorPreviewDeps,
): Extension | null {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  const ext = lower.split(".").pop() ?? "";
  if (name === "dockerfile" || name === "containerfile") {
    return deps.StreamLanguage.define(deps.dockerFile);
  }
  if (name === "makefile" || name.endsWith(".mk")) {
    return deps.StreamLanguage.define(deps.shell);
  }
  if (
    name === "gemfile" ||
    name === "rakefile" ||
    name === "podfile" ||
    name.endsWith(".gemspec")
  ) {
    return deps.StreamLanguage.define(deps.ruby);
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return deps.StreamLanguage.define(deps.shell);
  }
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return deps.javascript();
    case "jsx":
      return deps.javascript({ jsx: true });
    case "ts":
      return deps.javascript({ typescript: true });
    case "tsx":
      return deps.javascript({ typescript: true, jsx: true });
    case "json":
    case "jsonc":
      return deps.json();
    case "py":
      return deps.python();
    case "html":
    case "htm":
      return deps.html();
    case "css":
      return deps.css();
    case "scss":
      return deps.sass();
    case "sass":
      return deps.sass({ indented: true });
    case "less":
      return deps.StreamLanguage.define(deps.less);
    case "md":
    case "markdown":
    case "mdx":
      return deps.markdown();
    case "java":
      return deps.java();
    case "c":
    case "cc":
    case "cpp":
    case "cxx":
    case "h":
    case "hpp":
      return deps.cpp();
    case "go":
      return deps.go();
    case "rs":
      return deps.rust();
    case "sql":
      return deps.sql();
    case "xml":
    case "svg":
      return deps.xml();
    case "yaml":
    case "yml":
      return deps.yaml();
    case "php":
    case "phtml":
      return deps.php();
    case "vue":
      return deps.vue();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
      return deps.StreamLanguage.define(deps.shell);
    case "toml":
      return deps.StreamLanguage.define(deps.toml);
    case "rb":
    case "rake":
      return deps.StreamLanguage.define(deps.ruby);
    case "lua":
      return deps.StreamLanguage.define(deps.lua);
    case "pl":
    case "pm":
    case "t":
      return deps.StreamLanguage.define(deps.perl);
    case "swift":
      return deps.StreamLanguage.define(deps.swift);
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return deps.StreamLanguage.define(deps.clojure);
    case "r":
      return deps.StreamLanguage.define(deps.r);
    case "ps1":
    case "psm1":
    case "psd1":
      return deps.StreamLanguage.define(deps.powerShell);
    default:
      return null;
  }
}
