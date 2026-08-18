import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionFile } from "./session-types";
import {
  cleanMessageText,
  isRecord,
  stringValue,
  textFromContent,
} from "./session-utils";

type GrokSessionSummary = {
  sessionId: string;
  cwd: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  modelName?: string;
  agentVersion?: string;
};

export type GrokSessionDescriptor = {
  session: GrokSessionSummary;
  file: SessionFile;
};

// Respect Grok's supported home override while keeping the default colocated
// with the CLI installation in the current user's home directory.
function grokHome() {
  const configured = process.env.GROK_HOME?.trim();
  if (!configured) return join(homedir(), ".grok");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function grokSessionsRoot() {
  return join(grokHome(), "sessions");
}

function safeSessionId(value: string) {
  return !!value && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function dateValueMs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readSummary(path: string): Promise<GrokSessionSummary | null> {
  try {
    const raw: unknown = JSON.parse(await Bun.file(path).text());
    if (!isRecord(raw)) return null;
    const info = isRecord(raw.info) ? raw.info : {};
    const sessionId = stringValue(info.id) || basename(dirname(path));
    if (!sessionId) return null;
    return {
      sessionId,
      cwd: stringValue(info.cwd),
      createdAtMs: dateValueMs(raw.created_at),
      updatedAtMs: dateValueMs(raw.updated_at),
      modelName: stringValue(raw.current_model_id) || undefined,
      agentVersion: stringValue(raw.version) || undefined,
    };
  } catch {
    return null;
  }
}

// Grok keeps the canonical chat transcript beside summary.json in each session
// directory. Convert that directory into the metadata used by all GUI readers.
async function describeSessionDirectory(
  sessionDir: string,
): Promise<GrokSessionDescriptor | null> {
  const transcriptPath = join(sessionDir, "chat_history.jsonl");
  const summaryPath = join(sessionDir, "summary.json");
  if (!existsSync(transcriptPath) || !existsSync(summaryPath)) return null;
  const [summary, transcriptInfo] = await Promise.all([
    readSummary(summaryPath),
    stat(transcriptPath).catch(() => null),
  ]);
  if (!summary || !transcriptInfo?.isFile()) return null;
  return {
    session: summary,
    file: {
      path: transcriptPath,
      mtimeMs: summary.updatedAtMs ?? transcriptInfo.mtimeMs,
      size: transcriptInfo.size,
      sessionId: summary.sessionId,
      createdAtMs: summary.createdAtMs,
      modelName: summary.modelName,
      agentVersion: summary.agentVersion,
    },
  };
}

function sameDirectory(left: string, right: string) {
  return resolve(left) === resolve(right);
}

async function newestDescriptor(sessionDirs: string[], cwd?: string) {
  const descriptors = (
    await Promise.all(sessionDirs.map((path) => describeSessionDirectory(path)))
  ).filter((item): item is GrokSessionDescriptor => !!item);
  return (
    descriptors
      .filter(
        (item) =>
          !cwd || (!!item.session.cwd && sameDirectory(item.session.cwd, cwd)),
      )
      .toSorted((a, b) => b.file.mtimeMs - a.file.mtimeMs)[0] ?? null
  );
}

// The cwd directory name is percent-encoded by Grok, so lookup is constant-time
// with respect to unrelated sessions and remains cheap when Session Inspect polls.
export async function findGrokSessionForCwd(
  cwd: string,
  root = grokSessionsRoot(),
) {
  if (!cwd) return null;
  const cwdRoot = join(root, encodeURIComponent(resolve(cwd)));
  let entries;
  try {
    entries = await readdir(cwdRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  return newestDescriptor(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cwdRoot, entry.name)),
    cwd,
  );
}

// Prefer an exact cwd/id lookup. The one-level fallback supports a future
// Herdr Grok integration that reports only the native session id.
export async function findGrokSessionById(
  id: string,
  cwd = "",
  root = grokSessionsRoot(),
) {
  if (!safeSessionId(id)) return null;
  if (cwd) {
    const direct = await describeSessionDirectory(
      join(root, encodeURIComponent(resolve(cwd)), id),
    );
    if (direct) return direct;
  }
  let cwdEntries;
  try {
    cwdEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  return newestDescriptor(
    cwdEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, id)),
  );
}

// Normalize either a Grok session directory or one of the files inside it.
export async function describeGrokSessionPath(path: string) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  return describeSessionDirectory(info.isDirectory() ? path : dirname(path));
}

// Grok prepends environment snapshots to the first user record and emits other
// injected context as synthetic user records. Only the explicit query is history.
export function grokUserMessageText(record: Record<string, unknown>) {
  if (record.type !== "user" || stringValue(record.synthetic_reason)) return "";
  const content = textFromContent(record.content);
  const queries = Array.from(
    content.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi),
  )
    .map((match) => cleanMessageText(match[1] ?? ""))
    .filter(Boolean);
  if (queries.length > 0) return queries.join("\n\n");
  return cleanMessageText(
    content
      .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
      .replace(/<git_status>[\s\S]*?<\/git_status>/gi, "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ""),
  );
}

export function grokReasoningText(record: Record<string, unknown>) {
  return cleanMessageText(textFromContent(record.summary ?? record.content));
}
