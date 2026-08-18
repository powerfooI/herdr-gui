const FILE_PATH_CANDIDATE_RE =
  /(?:\/[A-Za-z0-9._~:@%+=,/-]+|\.\/[A-Za-z0-9._~:@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)*|[A-Za-z0-9._~@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)+)/g;
const TRAILING_PROSE_RE = /[.,;:!?]+$/;
const TRAILING_LOCATION_RE = /:\d+(?::\d+)?$/;
const PATH_BOUNDARY_RE = /[\s"'`([{<]/;
const MAX_CANDIDATES_PER_LINE = 32;
const DEFAULT_POSITIVE_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;

export type TextRange = { start: number; end: number };

export type TerminalFileLinkCandidate = {
  path: string;
  start: number;
  end: number;
  absolute: boolean;
};

export type ResolvedTerminalFile = {
  candidate: string;
  path: string;
};

function overlapsRange(start: number, end: number, ranges: TextRange[]) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function isSafePath(path: string) {
  if (path.startsWith("~/")) return false;
  const absolute = path.startsWith("/");
  const explicitlyRelative = path.startsWith("./");
  const relative = path.startsWith("/")
    ? path.slice(1)
    : explicitlyRelative
      ? path.slice(2)
      : path;
  const parts = relative.split("/");
  return (
    parts.length >= (absolute || explicitlyRelative ? 1 : 2) &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}

export function findTerminalFileLinkCandidates(
  text: string,
  excludedRanges: TextRange[] = [],
): TerminalFileLinkCandidate[] {
  const candidates: TerminalFileLinkCandidate[] = [];
  FILE_PATH_CANDIDATE_RE.lastIndex = 0;
  for (const match of text.matchAll(FILE_PATH_CANDIDATE_RE)) {
    const start = match.index ?? 0;
    const previous = start > 0 ? (text[start - 1] ?? "") : "";
    if (previous && !PATH_BOUNDARY_RE.test(previous)) continue;
    const path = match[0]
      .replace(TRAILING_PROSE_RE, "")
      .replace(TRAILING_LOCATION_RE, "");
    if (!isSafePath(path)) continue;
    const end = start + path.length;
    if (overlapsRange(start, end, excludedRanges)) continue;
    candidates.push({ path, start, end, absolute: path.startsWith("/") });
    if (candidates.length >= MAX_CANDIDATES_PER_LINE) break;
  }
  return candidates;
}

type CacheEntry = { path: string | null; expiresAt: number };
type BatchResolver = (
  workspaceId: string,
  candidates: string[],
) => Promise<ResolvedTerminalFile[]>;

export class TerminalFileResolutionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly resolveBatch: BatchResolver,
    private readonly options: {
      positiveTtlMs?: number;
      negativeTtlMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {}

  private key(workspaceId: string, candidate: string) {
    return `${workspaceId}\0${candidate}`;
  }

  private remember(key: string, path: string | null) {
    const now = this.options.now?.() ?? Date.now();
    const ttl = path
      ? (this.options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS)
      : (this.options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS);
    this.entries.delete(key);
    this.entries.set(key, { path, expiresAt: now + ttl });
    const maxEntries = this.options.maxEntries ?? 5_000;
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  async resolve(workspaceId: string, rawCandidates: string[]) {
    const candidates = Array.from(new Set(rawCandidates)).slice(
      0,
      MAX_CANDIDATES_PER_LINE,
    );
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string | null>>();
    const missing: string[] = [];
    const now = this.options.now?.() ?? Date.now();

    for (const candidate of candidates) {
      const key = this.key(workspaceId, candidate);
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        if (cached.path) resolved.set(candidate, cached.path);
        continue;
      }
      if (cached) this.entries.delete(key);
      const running = this.inFlight.get(key);
      if (running) pending.set(candidate, running);
      else missing.push(candidate);
    }

    if (missing.length > 0) {
      const request = this.resolveBatch(workspaceId, missing).then((files) => {
        const byCandidate = new Map(
          files
            .filter((file) => missing.includes(file.candidate) && file.path)
            .map((file) => [file.candidate, file.path]),
        );
        for (const candidate of missing) {
          this.remember(
            this.key(workspaceId, candidate),
            byCandidate.get(candidate) ?? null,
          );
        }
        return byCandidate;
      });
      for (const candidate of missing) {
        const key = this.key(workspaceId, candidate);
        const item = request.then((files) => files.get(candidate) ?? null);
        this.inFlight.set(key, item);
        item.then(
          () => this.inFlight.delete(key),
          () => this.inFlight.delete(key),
        );
        pending.set(candidate, item);
      }
    }

    await Promise.all(
      Array.from(pending, async ([candidate, promise]) => {
        const path = await promise;
        if (path) resolved.set(candidate, path);
      }),
    );
    return resolved;
  }
}
