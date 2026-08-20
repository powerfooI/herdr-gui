export type SyntaxTokenRange = {
  from: number;
  to: number;
  className: string;
};

export type DiffSyntaxViewMode = "split" | "unified";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cljc: "clojure",
  cljs: "clojure",
  cpp: "cpp",
  cts: "typescript",
  cxx: "cpp",
  edn: "clojure",
  fish: "bash",
  gemspec: "ruby",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "javascript",
  ksh: "bash",
  less: "less",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mk: "makefile",
  mkdn: "markdown",
  mts: "typescript",
  phtml: "php",
  php: "php",
  pl: "perl",
  plist: "xml",
  pm: "perl",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  py: "python",
  pyw: "python",
  r: "r",
  rake: "ruby",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  t: "perl",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xhtml: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

let syntaxHighlighterPromise: Promise<
  Awaited<ReturnType<typeof importSyntaxHighlighter>>
> | null = null;

async function importSyntaxHighlighter() {
  const [slimModule, helpersModule, rModule] = await Promise.all([
    import("diff2html/lib-esm/ui/js/highlight.js-slim"),
    import("diff2html/lib-esm/ui/js/highlight.js-helpers"),
    import("highlight.js/lib/languages/r"),
  ]);
  const highlighter = slimModule.hljs;
  if (!highlighter.getLanguage("r")) {
    highlighter.registerLanguage("r", rModule.default);
  }
  return {
    highlighter,
    getLanguage: helpersModule.getLanguage,
  };
}

function loadSyntaxHighlighter() {
  syntaxHighlighterPromise ??= importSyntaxHighlighter();
  return syntaxHighlighterPromise;
}

export function syntaxLanguageHintForPath(path: string) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;

  if (name === "dockerfile" || name === "containerfile") {
    return "dockerfile";
  }
  if (name === "makefile" || name === "gnumakefile") {
    return "makefile";
  }
  if (name === "gemfile" || name === "rakefile" || name === "podfile") {
    return "ruby";
  }
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".bashrc" ||
    name === ".zshrc"
  ) {
    return "bash";
  }

  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0 || extensionIndex === name.length - 1) {
    return "plaintext";
  }
  const extension = name.slice(extensionIndex + 1);
  return LANGUAGE_BY_EXTENSION[extension] ?? extension;
}

function resolvedSyntaxLanguage(
  path: string,
  deps: Awaited<ReturnType<typeof importSyntaxHighlighter>>,
) {
  const hint = syntaxLanguageHintForPath(path);
  if (deps.highlighter.getLanguage(hint)) return hint;
  const mapped = deps.getLanguage(hint);
  return deps.highlighter.getLanguage(mapped) ? mapped : "plaintext";
}

const HIGHLIGHT_TAG_PATTERN = /<span class="([^"]+)">|<\/span>/g;
const HIGHLIGHT_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27);/g;

function highlightedTextLength(markup: string) {
  return markup.replace(HIGHLIGHT_ENTITY_PATTERN, "x").length;
}

function collectTokenRanges(markup: string, expectedLength: number) {
  const ranges: SyntaxTokenRange[] = [];
  const stack: Array<{ from: number; className: string }> = [];
  let markupOffset = 0;
  let textOffset = 0;

  for (const match of markup.matchAll(HIGHLIGHT_TAG_PATTERN)) {
    const matchOffset = match.index ?? markupOffset;
    textOffset += highlightedTextLength(
      markup.slice(markupOffset, matchOffset),
    );
    markupOffset = matchOffset + match[0].length;

    if (match[1]) {
      stack.push({ from: textOffset, className: match[1] });
      continue;
    }
    const token = stack.pop();
    if (token && textOffset > token.from) {
      ranges.push({ ...token, to: textOffset });
    }
  }

  textOffset += highlightedTextLength(markup.slice(markupOffset));
  return textOffset === expectedLength && stack.length === 0 ? ranges : [];
}

export async function highlightCodeTokens(text: string, path: string) {
  if (!text) return [];
  const deps = await loadSyntaxHighlighter();
  const language = resolvedSyntaxLanguage(path, deps);
  if (language === "plaintext") return [];

  const result = deps.highlighter.highlight(text, {
    language,
    ignoreIllegals: true,
  });
  return collectTokenRanges(result.value, text.length);
}

export async function highlightDiffCode(
  root: HTMLElement,
  viewMode: DiffSyntaxViewMode,
) {
  const [deps, { Diff2HtmlUI }] = await Promise.all([
    loadSyntaxHighlighter(),
    import("diff2html/lib-esm/ui/js/diff2html-ui-base"),
  ]);
  for (const container of root.querySelectorAll<HTMLElement>(
    ".diff-file-html[data-syntax-path]",
  )) {
    if (!container.querySelector(".d2h-code-line-ctn:not(.hljs)")) continue;

    const path = container.dataset.syntaxPath ?? "";
    const language = resolvedSyntaxLanguage(path, deps);
    for (const wrapper of container.querySelectorAll<HTMLElement>(
      ".d2h-file-wrapper",
    )) {
      wrapper.dataset.lang = language;
    }

    const ui = new Diff2HtmlUI(
      container,
      undefined,
      {
        highlight: true,
        highlightLanguages: new Map([[language, language]]),
        drawFileList: false,
        outputFormat: viewMode === "split" ? "side-by-side" : "line-by-line",
      },
      deps.highlighter,
    );
    ui.highlightCode();
  }
}
