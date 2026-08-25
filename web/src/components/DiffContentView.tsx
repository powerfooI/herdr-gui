import { DEFAULT_THEMES } from "@pierre/diffs";
import {
  PatchDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Search,
  X,
} from "lucide-react";
import {
  Component,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ConnectionClient } from "../api";
import type { FilePreview, GitDiffEntry, GitDiffFile } from "../types";
import { connectionClientScopeKey } from "../useConnectionClient";
import { requestFilePreview } from "./FileExplorerDialog";
import {
  diffAutoCollapseInfo,
  type DiffAutoCollapseInfo,
} from "./diffAutoCollapse";
import {
  readDiffCollapseState,
  writeDiffCollapseState,
} from "./diffContentState";

type DiffViewMode = "split" | "unified";
type AppTheme = "dark" | "light";
type PierreDiffOptions = NonNullable<
  ComponentProps<typeof PatchDiff>["options"]
>;

const DIFF_VIEW_MODE_KEY = "diffViewMode";
const DESKTOP_DIFF_WRAP_KEY = "desktopDiffWrap";
const MOBILE_DIFF_WRAP_KEY = "mobileDiffWrap";
const DIFF_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(
    Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    globalThis.matchMedia?.("(pointer: coarse)")?.matches ? 1 : 2,
  ),
  totalASTLRUCacheSize: 8,
  workerFactory: () =>
    new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
      type: "module",
    }),
};
const DIFF_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-wasm",
};

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

type ImagePreviewTarget = {
  key: string;
  file: GitDiffFile;
};

function startImagePreviewRequest(
  target: ImagePreviewTarget,
  client: ConnectionClient,
  isCurrent: () => boolean,
  onComplete: (key: string, state: ImagePreviewState) => void,
) {
  void requestFilePreview(target.file.workspace_id, target.file.path, {
    client,
    refresh: true,
  })
    .then((preview) => {
      if (!isCurrent()) return;
      onComplete(target.key, { preview, loading: false, error: null });
    })
    .catch((error) => {
      if (!isCurrent()) return;
      onComplete(target.key, {
        preview: null,
        loading: false,
        error: (error as Error).message,
      });
    });
}

type DiffSearchGroup = {
  key: string;
};

type DiffSection = {
  key: string;
  active: boolean;
  entry: GitDiffEntry;
  file: GitDiffFile | null;
  imagePreview: boolean;
  autoCollapse: DiffAutoCollapseInfo | null;
  collapsed: boolean;
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

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(currentDocumentTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

export function diffContentEntries(
  entries: GitDiffEntry[],
  entry: GitDiffEntry | null,
) {
  return entries.length ? entries : entry ? [entry] : [];
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

function literalSearchPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

export function diffSearchGroups(
  entries: GitDiffEntry[],
  files: Record<string, GitDiffFile>,
  query: string,
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { groups: [] as DiffSearchGroup[], count: 0 };
  }
  const pattern = literalSearchPattern(normalizedQuery);
  const groups: DiffSearchGroup[] = [];
  for (const entry of entries) {
    const key = diffEntryKey(entry);
    const diff = files[key]?.diff;
    if (!diff || isBinaryDiffText(diff)) continue;
    if (pattern.test(diff)) groups.push({ key });
  }
  return { groups, count: groups.length };
}

function searchEntryKey(groups: DiffSearchGroup[], index: number) {
  return index < 0 ? null : (groups[index]?.key ?? null);
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

class DiffRenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function RawPatch({ patch }: { patch: string }) {
  return <pre className="diff-raw-patch">{patch}</pre>;
}

type DiffFileSectionProps = {
  section: DiffSection;
  loading: boolean;
  imagePreviewState?: ImagePreviewState;
  options: PierreDiffOptions;
  currentSearchMatch: boolean;
  onToggle: (key: string, collapsed: boolean) => void;
  onSelectFile?: (entry: GitDiffEntry) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
};

const DiffFileSection = memo(function DiffFileSection({
  section,
  loading,
  imagePreviewState,
  options,
  currentSearchMatch,
  onToggle,
  onSelectFile,
  onOpenFile,
}: DiffFileSectionProps) {
  const toggle = () => {
    if (section.active) {
      onToggle(section.key, section.collapsed);
      return;
    }
    onToggle(section.key, true);
    onSelectFile?.(section.entry);
  };

  return (
    <article
      className={`diff-file-section ${currentSearchMatch ? "is-search-current" : ""}`}
      data-diff-entry-key={section.key}
      aria-current={currentSearchMatch ? "true" : undefined}
    >
      <header className="diff-file-section-head">
        <button
          type="button"
          className="diff-file-collapse"
          onClick={toggle}
          disabled={!section.active && !onSelectFile}
          aria-expanded={!section.collapsed}
          aria-label={`${section.collapsed ? "Expand" : "Collapse"} ${section.entry.path}`}
          title={section.collapsed ? "Expand" : "Collapse"}
        >
          {section.collapsed ? (
            <ChevronRight size={14} />
          ) : (
            <ChevronDown size={14} />
          )}
        </button>
        <div className="diff-file-section-title">
          <strong>{section.entry.path}</strong>
          <span>
            {section.entry.kind} · {section.entry.status}
            {section.autoCollapse ? ` · ${section.autoCollapse.label}` : ""}
            {section.file?.truncated ? " · truncated" : ""}
            {section.collapsed && section.autoCollapse
              ? " · auto-collapsed"
              : ""}
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
      {section.collapsed ? null : (
        <>
          {section.error ? (
            <div className="diff-content-state is-error">{section.error}</div>
          ) : null}
          {!section.file && !section.error ? (
            <div className="diff-content-state">
              {loading ? <span className="file-loading-spinner" /> : null}
              {loading ? "Loading diff" : "Select this file to load its diff."}
            </div>
          ) : null}
          {section.file && !section.file.diff && !section.imagePreview ? (
            <div className="diff-content-state">No textual diff available.</div>
          ) : null}
          {section.imagePreview && section.file ? (
            <DiffImagePreview
              state={imagePreviewState}
              path={section.entry.path}
            />
          ) : null}
          {section.file?.truncated ? (
            <div className="diff-truncated">Diff truncated at 512 KB.</div>
          ) : null}
          {section.file?.diff && !section.imagePreview ? (
            <div className="pierre-diff-surface">
              <DiffRenderBoundary
                fallback={<RawPatch patch={section.file.diff} />}
                resetKey={section.file.diff}
              >
                <PatchDiff patch={section.file.diff} options={options} />
              </DiffRenderBoundary>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}, areDiffFileSectionPropsEqual);

function areDiffFileSectionPropsEqual(
  previous: Readonly<DiffFileSectionProps>,
  next: Readonly<DiffFileSectionProps>,
) {
  return (
    previous.section.key === next.section.key &&
    previous.section.active === next.section.active &&
    previous.section.entry === next.section.entry &&
    previous.section.file === next.section.file &&
    previous.section.imagePreview === next.section.imagePreview &&
    previous.section.collapsed === next.section.collapsed &&
    previous.section.error === next.section.error &&
    previous.section.autoCollapse?.reason ===
      next.section.autoCollapse?.reason &&
    previous.section.autoCollapse?.label === next.section.autoCollapse?.label &&
    previous.loading === next.loading &&
    previous.imagePreviewState === next.imagePreviewState &&
    previous.options === next.options &&
    previous.currentSearchMatch === next.currentSearchMatch &&
    previous.onToggle === next.onToggle &&
    previous.onSelectFile === next.onSelectFile &&
    previous.onOpenFile === next.onOpenFile
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
  resourceKey = "default",
  connectionClient,
  onSelectFile,
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
  resourceKey?: string;
  connectionClient: ConnectionClient;
  onSelectFile?: (entry: GitDiffEntry) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectFileRef = useRef(onSelectFile);
  const openFileRef = useRef(onOpenFile);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    loadDiffViewMode(),
  );
  const [desktopWrap, setDesktopWrap] = useState(() => loadDesktopDiffWrap());
  const [mobileWrap, setMobileWrap] = useState(() => loadMobileDiffWrap());
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, ImagePreviewState>
  >({});
  const requestedImagePreviewsRef = useRef(new Map<string, GitDiffFile>());
  const imagePreviewRequestSeqRef = useRef(0);
  const imagePreviewRequestByKeyRef = useRef(new Map<string, number>());
  const [manualCollapseStates, setManualCollapseStates] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map(readDiffCollapseState(resourceKey)));
  const theme = useDocumentTheme();
  const effectiveViewMode: DiffViewMode = mobile ? "unified" : viewMode;
  const wrapEnabled = mobile ? mobileWrap : desktopWrap;
  const activeEntryKey = entry ? diffEntryKey(entry) : "";
  const filesByKey = useMemo(() => {
    const merged = { ...files };
    if (entry && file) merged[diffEntryKey(entry)] = file;
    return merged;
  }, [entry, file, files]);
  const visibleEntries = useMemo(
    () => diffContentEntries(entries, entry),
    [entries, entry],
  );
  const changedFileCount = entries.length || visibleEntries.length;
  const renderedSections = useMemo<DiffSection[]>(
    () =>
      visibleEntries.map((visibleEntry) => {
        const key = diffEntryKey(visibleEntry);
        const diffFile = filesByKey[key] ?? null;
        const imagePreview =
          !!diffFile &&
          isPreviewableImagePath(visibleEntry.path) &&
          (!diffFile.diff || isBinaryDiffText(diffFile.diff));
        const autoCollapse = diffAutoCollapseInfo(visibleEntry, diffFile);
        const defaultCollapsed = autoCollapse !== null;
        const active = key === activeEntryKey;
        return {
          key,
          active,
          entry: visibleEntry,
          file: diffFile,
          imagePreview,
          autoCollapse,
          collapsed:
            !active || (manualCollapseStates.get(key) ?? defaultCollapsed),
          error: fileErrors[key] ?? null,
        };
      }),
    [
      activeEntryKey,
      fileErrors,
      filesByKey,
      manualCollapseStates,
      visibleEntries,
    ],
  );
  const activeSection = renderedSections.find((section) => section.active);
  const renderedKey = `${activeEntryKey}:${activeSection?.file?.diff.length ?? 0}:${renderedSections.length}`;
  const hasExpandedTextDiff = renderedSections.some(
    (section) =>
      !section.collapsed && !!section.file?.diff && !section.imagePreview,
  );
  const imagePreviewTargets = useMemo(
    () =>
      renderedSections.flatMap((section) =>
        !section.collapsed && section.imagePreview && section.file
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
  const searchResult = useMemo(
    () => diffSearchGroups(visibleEntries, filesByKey, deferredSearchQuery),
    [deferredSearchQuery, filesByKey, visibleEntries],
  );
  const searchMatchCount = searchResult.count;
  const currentSearchEntryKey = searchEntryKey(
    searchResult.groups,
    searchIndex,
  );
  const hasSearchableDiff = useMemo(
    () => Object.values(filesByKey).some((candidate) => !!candidate.diff),
    [filesByKey],
  );
  const handleSelectFile = useCallback((target: GitDiffEntry) => {
    selectFileRef.current?.(target);
  }, []);
  const handleOpenFile = useCallback((target: GitDiffEntry) => {
    openFileRef.current?.(target);
  }, []);
  const completeImagePreview = useCallback(
    (key: string, state: ImagePreviewState) => {
      setImagePreviews((current) => ({ ...current, [key]: state }));
    },
    [],
  );
  const pierreOptions = useMemo<PierreDiffOptions>(
    () => ({
      theme: DEFAULT_THEMES,
      themeType: theme,
      diffStyle: effectiveViewMode === "split" ? "split" : "unified",
      overflow: wrapEnabled ? "wrap" : "scroll",
      disableFileHeader: true,
      stickyHeader: false,
      diffIndicators: "bars",
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      maxLineDiffLength: 2_000,
      tokenizeMaxLineLength: 4_000,
      tokenizeMaxLength: 250_000,
      preferredHighlighter: "shiki-wasm",
    }),
    [effectiveViewMode, theme, wrapEnabled],
  );

  useEffect(() => {
    selectFileRef.current = onSelectFile;
  }, [onSelectFile]);
  useEffect(() => {
    openFileRef.current = onOpenFile;
  }, [onOpenFile]);
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
  }, [connectionClient, resourceKey]);
  useEffect(() => {
    const activeKeys = new Set(imagePreviewTargets.map((target) => target.key));
    for (const key of requestedImagePreviewsRef.current.keys()) {
      if (!activeKeys.has(key)) requestedImagePreviewsRef.current.delete(key);
    }
    for (const key of imagePreviewRequestByKeyRef.current.keys()) {
      if (!activeKeys.has(key)) imagePreviewRequestByKeyRef.current.delete(key);
    }
    setImagePreviews((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([key]) => activeKeys.has(key)),
      );
      return Object.keys(retained).length === Object.keys(current).length
        ? current
        : retained;
    });

    const requests = imagePreviewTargets.flatMap((target) => {
      if (requestedImagePreviewsRef.current.get(target.key) === target.file) {
        return [];
      }
      requestedImagePreviewsRef.current.set(target.key, target.file);
      const requestSeq = ++imagePreviewRequestSeqRef.current;
      imagePreviewRequestByKeyRef.current.set(target.key, requestSeq);
      return [{ target, requestSeq }];
    });
    if (!requests.length) return;

    setImagePreviews((current) => ({
      ...current,
      ...Object.fromEntries(
        requests.map(({ target }) => [
          target.key,
          { preview: null, loading: true, error: null },
        ]),
      ),
    }));

    for (const { target, requestSeq } of requests) {
      startImagePreviewRequest(
        target,
        connectionClient,
        () =>
          connectionClient.isCurrent() &&
          imagePreviewRequestByKeyRef.current.get(target.key) === requestSeq,
        completeImagePreview,
      );
    }
  }, [completeImagePreview, connectionClient, imagePreviewTargets]);

  useEffect(() => {
    if (!activeEntryKey || !sectionRef.current) return;
    requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find((element) => element.dataset.diffEntryKey === activeEntryKey);
      target?.scrollIntoView({ block: "start" });
    });
  }, [activeEntryKey, renderedKey]);

  useEffect(() => {
    setSearchIndex(searchMatchCount ? 0 : -1);
  }, [deferredSearchQuery, searchMatchCount]);

  useEffect(() => {
    if (!currentSearchEntryKey || !sectionRef.current) return;
    setManualCollapseStates((current) => {
      if (current.get(currentSearchEntryKey) === false) return current;
      const next = new Map(current);
      next.set(currentSearchEntryKey, false);
      writeDiffCollapseState(resourceKey, next);
      return next;
    });
    requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find(
        (element) => element.dataset.diffEntryKey === currentSearchEntryKey,
      );
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [currentSearchEntryKey, resourceKey]);

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

  const toggleSectionCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      setManualCollapseStates((current) => {
        const next = new Map(current);
        next.set(key, !collapsed);
        writeDiffCollapseState(resourceKey, next);
        return next;
      });
    },
    [resourceKey],
  );

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

  const diffList = visibleEntries.length ? (
    <Virtualizer
      className={`pierre-diff-scroll ${mobile ? "is-compact" : ""}`}
      contentClassName="pierre-diff-scroll-content"
    >
      {renderedSections.map((section) => (
        <DiffFileSection
          key={section.key}
          section={section}
          loading={loading && activeEntryKey === section.key && !section.file}
          imagePreviewState={
            section.file
              ? imagePreviews[imagePreviewKey(connectionClient, section.file)]
              : undefined
          }
          options={pierreOptions}
          currentSearchMatch={currentSearchEntryKey === section.key}
          onToggle={toggleSectionCollapsed}
          onSelectFile={onSelectFile ? handleSelectFile : undefined}
          onOpenFile={onOpenFile ? handleOpenFile : undefined}
        />
      ))}
    </Virtualizer>
  ) : null;

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
            {changedFileCount
              ? `${changedFileCount} changed file${
                  changedFileCount === 1 ? "" : "s"
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
          <div className="diff-search-controls">
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
                placeholder="Find loaded files"
                disabled={!hasSearchableDiff}
              />
            </label>
            <span
              className="diff-search-count"
              role="status"
              aria-live="polite"
            >
              {deferredSearchQuery && searchMatchCount
                ? `${searchIndex + 1}/${searchMatchCount}`
                : deferredSearchQuery
                  ? "No results"
                  : ""}
            </span>
            <button
              type="button"
              className="diff-search-button"
              onClick={() => goToSearchMatch(-1)}
              disabled={!searchMatchCount}
              aria-label="Previous matching loaded file"
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="diff-search-button"
              onClick={() => goToSearchMatch(1)}
              disabled={!searchMatchCount}
              aria-label="Next matching loaded file"
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
          </div>
          {!mobile ? (
            <div className="diff-display-controls">
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
            </div>
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
      {hasExpandedTextDiff && diffList ? (
        <WorkerPoolContextProvider
          poolOptions={DIFF_WORKER_POOL_OPTIONS}
          highlighterOptions={DIFF_HIGHLIGHTER_OPTIONS}
        >
          {diffList}
        </WorkerPoolContextProvider>
      ) : (
        diffList
      )}
    </section>
  );
}
