import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { html as diffToHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { ConnectionClient } from "../api";
import type { FilePreview, GitDiffEntry, GitDiffFile } from "../types";
import { connectionClientScopeKey } from "../useConnectionClient";
import { requestFilePreview } from "./FileExplorerDialog";

type DiffViewMode = "split" | "unified";

const DIFF_VIEW_MODE_KEY = "diffViewMode";
const DESKTOP_DIFF_WRAP_KEY = "desktopDiffWrap";
const MOBILE_DIFF_WRAP_KEY = "mobileDiffWrap";
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

type ImagePreviewState = {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
};

function loadDiffViewMode(): DiffViewMode {
  return localStorage.getItem(DIFF_VIEW_MODE_KEY) === "unified"
    ? "unified"
    : "split";
}

function loadMobileDiffWrap() {
  return localStorage.getItem(MOBILE_DIFF_WRAP_KEY) === "true";
}

function loadDesktopDiffWrap() {
  return localStorage.getItem(DESKTOP_DIFF_WRAP_KEY) !== "false";
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

function isPreviewableImagePath(path: string) {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(ext);
}

function isBinaryDiffText(diff: string) {
  return /^Binary files\b/m.test(diff) || /^GIT binary patch\b/m.test(diff);
}

function imagePreviewKey(client: ConnectionClient, file: GitDiffFile) {
  return connectionClientScopeKey(
    client,
    "diff-image-preview",
    file.workspace_id,
    file.path,
  );
}

function isEditableSearchTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".diff-search")) return false;
  if (target.closest(".cm-editor")) return true;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function clearDiffSearchMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll("mark.diff-search-match"));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

function markDiffSearchMatches(root: HTMLElement, query: string) {
  const normalizedQuery = query.toLowerCase();
  const matches: HTMLElement[] = [];
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue ?? "";
      if (!text.toLowerCase().includes(normalizedQuery)) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        parent.closest(
          "mark.diff-search-match,.d2h-code-linenumber,.d2h-code-side-linenumber",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    const lowerText = text.toLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = lowerText.indexOf(normalizedQuery);
    while (index >= 0) {
      if (index > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "diff-search-match";
      mark.textContent = text.slice(index, index + query.length);
      fragment.append(mark);
      matches.push(mark);
      cursor = index + query.length;
      index = lowerText.indexOf(normalizedQuery, cursor);
    }
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }

  return matches;
}

function DiffImagePreview({
  state,
  path,
}: {
  state?: ImagePreviewState;
  path: string;
}) {
  if (!state || state.loading) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading image preview
        </div>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state is-error">{state.error}</div>
      </div>
    );
  }
  if (!state.preview?.image_data_url) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">Image preview unavailable.</div>
      </div>
    );
  }
  return (
    <div className="diff-image-preview">
      <img
        className="diff-image-preview-img"
        src={state.preview.image_data_url}
        alt={path}
      />
    </div>
  );
}

export function DiffContentView({
  entry,
  file,
  loading,
  error,
  entries = [],
  files = {},
  fileErrors = {},
  summaryLoading = false,
  mobile = false,
  connectionClient,
  onOpenFile,
}: {
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries?: GitDiffEntry[];
  files?: Record<string, GitDiffFile>;
  fileErrors?: Record<string, string>;
  summaryLoading?: boolean;
  mobile?: boolean;
  connectionClient: ConnectionClient;
  onOpenFile?: (entry: GitDiffEntry) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const diffRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchMarksRef = useRef<HTMLElement[]>([]);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    loadDiffViewMode(),
  );
  const [desktopWrap, setDesktopWrap] = useState(() => loadDesktopDiffWrap());
  const [mobileWrap, setMobileWrap] = useState(() => loadMobileDiffWrap());
  const [syntaxVersion, setSyntaxVersion] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [searchVersion, setSearchVersion] = useState(0);
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, ImagePreviewState>
  >({});
  const requestedImagePreviewsRef = useRef<Set<string>>(new Set());
  const imagePreviewRequestSeqRef = useRef(0);
  const imagePreviewRequestByKeyRef = useRef(new Map<string, number>());
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const effectiveViewMode: DiffViewMode = mobile ? "unified" : viewMode;
  const wrapEnabled = mobile ? mobileWrap : desktopWrap;
  const activeSearchQuery = searchQuery;
  const activeEntryKey = entry ? diffEntryKey(entry) : "";
  const visibleEntries = useMemo(() => {
    if (entries.length) return entries;
    return entry ? [entry] : [];
  }, [entries, entry]);
  const filesByKey = useMemo(() => {
    const merged = { ...files };
    if (entry && file) merged[diffEntryKey(entry)] = file;
    return merged;
  }, [entry, file, files]);
  const renderedSections = useMemo(
    () =>
      visibleEntries.map((visibleEntry) => {
        const key = diffEntryKey(visibleEntry);
        const diffFile = filesByKey[key] ?? null;
        const imagePreview =
          !!diffFile &&
          isPreviewableImagePath(visibleEntry.path) &&
          (!diffFile.diff || isBinaryDiffText(diffFile.diff));
        return {
          key,
          entry: visibleEntry,
          file: diffFile,
          imagePreview,
          error: fileErrors[key] ?? null,
          html:
            diffFile?.diff && !imagePreview
              ? diffToHtml(diffFile.diff, {
                  drawFileList: false,
                  matching: "lines",
                  outputFormat:
                    effectiveViewMode === "split"
                      ? "side-by-side"
                      : "line-by-line",
                  renderNothingWhenEmpty: false,
                })
              : "",
        };
      }),
    [effectiveViewMode, fileErrors, filesByKey, visibleEntries],
  );
  const renderedKey = renderedSections
    .map((section) => `${section.key}:${section.html.length}`)
    .join("|");
  const hasRenderedDiff = renderedSections.some((section) => section.html);
  const syntaxKey = `${effectiveViewMode}:${renderedKey}`;
  const imagePreviewTargets = useMemo(
    () =>
      renderedSections.flatMap((section) =>
        section.imagePreview && section.file
          ? [
              {
                key: imagePreviewKey(connectionClient, section.file),
                file: section.file,
              },
            ]
          : [],
      ),
    [connectionClient, renderedSections],
  );

  useEffect(() => {
    localStorage.setItem(DIFF_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem(DESKTOP_DIFF_WRAP_KEY, String(desktopWrap));
  }, [desktopWrap]);
  useEffect(() => {
    localStorage.setItem(MOBILE_DIFF_WRAP_KEY, String(mobileWrap));
  }, [mobileWrap]);
  useEffect(() => {
    requestedImagePreviewsRef.current.clear();
    imagePreviewRequestByKeyRef.current.clear();
    imagePreviewRequestSeqRef.current += 1;
    setImagePreviews({});
  }, [connectionClient]);
  useEffect(() => {
    for (const target of imagePreviewTargets) {
      if (requestedImagePreviewsRef.current.has(target.key)) continue;
      requestedImagePreviewsRef.current.add(target.key);
      const requestSeq = ++imagePreviewRequestSeqRef.current;
      imagePreviewRequestByKeyRef.current.set(target.key, requestSeq);
      setImagePreviews((current) => ({
        ...current,
        [target.key]: { preview: null, loading: true, error: null },
      }));
      void requestFilePreview(target.file.workspace_id, target.file.path, {
        client: connectionClient,
      })
        .then((preview) => {
          if (
            !connectionClient.isCurrent() ||
            imagePreviewRequestByKeyRef.current.get(target.key) !== requestSeq
          ) {
            return;
          }
          setImagePreviews((current) => ({
            ...current,
            [target.key]: { preview, loading: false, error: null },
          }));
        })
        .catch((e) => {
          if (
            !connectionClient.isCurrent() ||
            imagePreviewRequestByKeyRef.current.get(target.key) !== requestSeq
          ) {
            return;
          }
          setImagePreviews((current) => ({
            ...current,
            [target.key]: {
              preview: null,
              loading: false,
              error: (e as Error).message,
            },
          }));
        });
    }
  }, [connectionClient, imagePreviewTargets]);
  useEffect(() => {
    if (!hasRenderedDiff || !diffRef.current) return;
    if (diffRef.current.dataset.syntaxKey === syntaxKey) return;
    let cancelled = false;
    void import("diff2html/lib-esm/ui/js/diff2html-ui-slim")
      .then(({ Diff2HtmlUI }) => {
        if (cancelled || !diffRef.current) return;
        const ui = new Diff2HtmlUI(diffRef.current, undefined, {
          highlight: true,
          drawFileList: false,
          outputFormat:
            effectiveViewMode === "split" ? "side-by-side" : "line-by-line",
        });
        ui.highlightCode();
      })
      .catch(() => {
        // Syntax highlighting is progressive; plain diff remains usable.
      })
      .finally(() => {
        if (!cancelled && diffRef.current) {
          diffRef.current.dataset.syntaxKey = syntaxKey;
          setSyntaxVersion((version) => version + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveViewMode, hasRenderedDiff, syntaxKey]);

  useEffect(() => {
    if (!activeEntryKey || !diffRef.current) return;
    requestAnimationFrame(() => {
      const target = Array.from(
        diffRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find((element) => element.dataset.diffEntryKey === activeEntryKey);
      target?.scrollIntoView({ block: "start" });
    });
  }, [activeEntryKey, renderedKey]);

  useEffect(() => {
    const root = diffRef.current;
    if (!root) {
      searchMarksRef.current = [];
      setSearchMatchCount(0);
      setSearchIndex(-1);
      return;
    }

    clearDiffSearchMarks(root);
    searchMarksRef.current = [];

    if (!hasRenderedDiff || !activeSearchQuery) {
      setSearchMatchCount(0);
      setSearchIndex(-1);
      setSearchVersion((version) => version + 1);
      return;
    }

    const marks = markDiffSearchMatches(root, activeSearchQuery);
    searchMarksRef.current = marks;
    setSearchMatchCount(marks.length);
    setSearchIndex(marks.length ? 0 : -1);
    setSearchVersion((version) => version + 1);

    return () => {
      if (root.isConnected) clearDiffSearchMarks(root);
    };
  }, [activeSearchQuery, hasRenderedDiff, renderedKey, syntaxVersion]);

  useEffect(() => {
    const marks = searchMarksRef.current;
    for (const mark of marks) {
      mark.classList.remove("is-current");
    }
    const current = searchIndex >= 0 ? marks[searchIndex] : null;
    if (!current) return;
    current.classList.add("is-current");
    current.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "smooth",
    });
  }, [searchIndex, searchMatchCount, searchVersion]);

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const goToSearchMatch = useCallback(
    (delta: number) => {
      if (!searchMatchCount) return;
      setSearchIndex((index) => {
        const base = index < 0 ? 0 : index;
        return (base + delta + searchMatchCount) % searchMatchCount;
      });
    },
    [searchMatchCount],
  );

  const toggleSectionCollapsed = useCallback((key: string) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const section = sectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditableSearchTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [focusSearch]);

  return (
    <section
      ref={sectionRef}
      className="diff-content-view"
      aria-label="Diff Viewer content"
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          if (isEditableSearchTarget(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          focusSearch();
        }
      }}
    >
      <div className="diff-content-head">
        <div className="diff-content-title">
          <strong>
            {visibleEntries.length
              ? `${visibleEntries.length} changed file${
                  visibleEntries.length === 1 ? "" : "s"
                }`
              : "Diff Viewer"}
          </strong>
          {entry ? <span>{entry.path}</span> : null}
        </div>
        {mobile ? (
          <button
            type="button"
            className={`diff-wrap-toggle ${mobileWrap ? "is-active" : ""}`}
            onClick={() => setMobileWrap((value) => !value)}
            aria-pressed={mobileWrap}
          >
            {mobileWrap ? "Wrap" : "No wrap"}
          </button>
        ) : null}
        <div className="diff-content-actions">
          <label className="diff-search">
            <Search size={13} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  goToSearchMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchQuery("");
                }
              }}
              placeholder="Search diff"
              disabled={!hasRenderedDiff}
            />
          </label>
          <span className="diff-search-count">
            {activeSearchQuery && searchMatchCount
              ? `${searchIndex + 1}/${searchMatchCount}`
              : activeSearchQuery
                ? "No results"
                : ""}
          </span>
          <button
            type="button"
            className="diff-search-button"
            onClick={() => goToSearchMatch(-1)}
            disabled={!searchMatchCount}
            aria-label="Previous diff search match"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="diff-search-button"
            onClick={() => goToSearchMatch(1)}
            disabled={!searchMatchCount}
            aria-label="Next diff search match"
          >
            <ChevronDown size={14} />
          </button>
          {searchQuery ? (
            <button
              type="button"
              className="diff-search-button"
              onClick={() => {
                setSearchQuery("");
                focusSearch();
              }}
              aria-label="Clear diff search"
            >
              <X size={14} />
            </button>
          ) : null}
          {!mobile ? (
            <>
              <div className="diff-view-toggle" aria-label="Diff view mode">
                <button
                  type="button"
                  className={viewMode === "split" ? "is-active" : ""}
                  onClick={() => setViewMode("split")}
                  aria-pressed={viewMode === "split"}
                >
                  Split
                </button>
                <button
                  type="button"
                  className={viewMode === "unified" ? "is-active" : ""}
                  onClick={() => setViewMode("unified")}
                  aria-pressed={viewMode === "unified"}
                >
                  Unified
                </button>
              </div>
              <button
                type="button"
                className={`diff-wrap-toggle ${desktopWrap ? "is-active" : ""}`}
                onClick={() => setDesktopWrap((value) => !value)}
                aria-pressed={desktopWrap}
              >
                {desktopWrap ? "Wrap" : "No wrap"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {error && !visibleEntries.length ? (
        <div className="diff-content-state is-error">{error}</div>
      ) : null}
      {summaryLoading && !visibleEntries.length ? (
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading diff
        </div>
      ) : null}
      {!summaryLoading && !error && !visibleEntries.length ? (
        <div className="diff-content-state">No changed files.</div>
      ) : null}
      {visibleEntries.length ? (
        <div
          ref={diffRef}
          className={`diff2html-wrapper ${
            mobile && wrapEnabled ? "is-wrapped" : ""
          } ${!mobile && !wrapEnabled ? "is-nowrap" : ""} ${
            !mobile ? `is-${effectiveViewMode}` : ""
          }`}
        >
          {renderedSections.map((section) => {
            const sectionLoading =
              loading && activeEntryKey === section.key && !section.file;
            const loadingFile = !section.file && !section.error;
            const collapsed = collapsedKeys.has(section.key);
            return (
              <article
                className="diff-file-section"
                key={section.key}
                data-diff-entry-key={section.key}
              >
                <header className="diff-file-section-head">
                  <button
                    type="button"
                    className="diff-file-collapse"
                    onClick={() => toggleSectionCollapsed(section.key)}
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.entry.path}`}
                    title={collapsed ? "Expand" : "Collapse"}
                  >
                    {collapsed ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                  <div className="diff-file-section-title">
                    <strong>{section.entry.path}</strong>
                    <span>
                      {section.entry.kind} · {section.entry.status}
                      {section.file?.truncated ? " · truncated" : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="diff-file-open"
                    onClick={() => onOpenFile?.(section.entry)}
                    disabled={!onOpenFile}
                  >
                    <FolderOpen size={14} />
                    <span>Open in Files</span>
                  </button>
                </header>
                {collapsed ? null : (
                  <>
                    {section.error ? (
                      <div className="diff-content-state is-error">
                        {section.error}
                      </div>
                    ) : null}
                    {loadingFile ? (
                      <div className="diff-content-state">
                        {sectionLoading ? (
                          <span className="file-loading-spinner" />
                        ) : null}
                        Loading diff
                      </div>
                    ) : null}
                    {section.file &&
                    !section.file.diff &&
                    !section.imagePreview ? (
                      <div className="diff-content-state">
                        No textual diff available.
                      </div>
                    ) : null}
                    {section.imagePreview && section.file ? (
                      <DiffImagePreview
                        state={
                          imagePreviews[
                            imagePreviewKey(connectionClient, section.file)
                          ]
                        }
                        path={section.entry.path}
                      />
                    ) : null}
                    {section.file?.truncated ? (
                      <div className="diff-truncated">
                        Diff truncated at 512 KB.
                      </div>
                    ) : null}
                    {section.html ? (
                      <div
                        className="diff-file-html"
                        dangerouslySetInnerHTML={{ __html: section.html }}
                      />
                    ) : null}
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
