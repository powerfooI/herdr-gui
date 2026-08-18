import { basename } from "node:path";
import type { HerdrCall, SessionFile } from "./session-types";
import { resolveAgentSession } from "./session-resolver";
import {
  localAgentSessionFiles,
  type AgentSessionFileAccess,
} from "./session-file-access";
import { conversationMessagesFromTrajectory } from "./session-messages";
import { projectAgentTrajectory } from "./session-trajectory";
import { isRecord } from "./session-utils";
import { summarizeTokenUsage } from "./token-usage";

const MAX_MESSAGES_PER_AGENT = 200;

function projectSession(
  agent: string,
  file: SessionFile,
  records: Record<string, unknown>[],
) {
  const trajectory = projectAgentTrajectory(agent, file, records);
  return {
    trajectory,
    messages: conversationMessagesFromTrajectory(file, trajectory),
  };
}

function parseJsonl(text: string) {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Session transcripts are append-only; the final line may be incomplete.
    }
  }
  return records;
}

async function readRecords(file: SessionFile, files: AgentSessionFileAccess) {
  return parseJsonl(await files.readText(file.path));
}

function parseSessionStats(
  messages: ReturnType<typeof conversationMessagesFromTrajectory>,
  records: Record<string, unknown>[],
) {
  return {
    turns: messages.filter((message) => message.role === "user").length,
    records: records.length,
    token_usage: summarizeTokenUsage(records),
  };
}

export async function readAgentMessageHistory(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
) {
  const resolved = await resolveAgentSession(rawParams, herdrCall, files);
  if (!resolved.file) {
    return {
      ...resolved,
      messages: [],
    };
  }
  const file = resolved.file;
  const records = await readRecords(file, files);
  const messages = projectSession(resolved.agent, file, records).messages.slice(
    -MAX_MESSAGES_PER_AGENT,
  );
  return {
    ...resolved,
    messages,
  };
}

export async function readAgentSessionSummary(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
) {
  const resolved = await resolveAgentSession(rawParams, herdrCall, files);
  if (!resolved.file) {
    return {
      ...resolved,
      stats: { turns: 0, records: 0, token_usage: null },
      text: null,
      truncated: false,
      trajectory: null,
    };
  }
  const records = await readRecords(resolved.file, files);
  const projected = projectSession(resolved.agent, resolved.file, records);
  const stats = parseSessionStats(projected.messages, records);
  const includeText = rawParams.include_text === true;
  const includeTrajectory = rawParams.include_trajectory === true;
  const previewLimit = Math.max(
    1,
    Math.min(Number(rawParams.preview_limit) || 512 * 1024, 2 * 1024 * 1024),
  );
  let text: string | null = null;
  let truncated = false;
  if (includeText) {
    const bytes = await files.readPrefix(resolved.file.path, previewLimit + 1);
    truncated =
      bytes.length > previewLimit || (resolved.file.size ?? 0) > previewLimit;
    text = new TextDecoder("utf-8", { fatal: false }).decode(
      truncated ? bytes.subarray(0, previewLimit) : bytes,
    );
  }
  const trajectory = includeTrajectory ? projected.trajectory : null;
  return { ...resolved, stats, text, truncated, trajectory };
}

function contentDispositionFilename(path: string) {
  const fallback =
    basename(path).replace(/[^\x20-\x7e]|["\r\n]/g, "_") || "session.jsonl";
  return `attachment; filename="${fallback}"`;
}

function contentDispositionAtifFilename(file: SessionFile) {
  const name = (file.sessionId || basename(file.path))
    .replace(/\.[^.]+$/, "")
    .replace(/[^\x20-\x7e]|["\r\n]/g, "_");
  const filename = `${name || "session"}.atif.json`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function downloadAgentSessionFile(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
) {
  const resolved = await resolveAgentSession(rawParams, herdrCall, files);
  if (!resolved.file) {
    return new Response(resolved.detail || "session file unavailable", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const body = await files.readDownloadBody(resolved.file.path);
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-length": String(resolved.file.size ?? 0),
      "content-disposition": contentDispositionFilename(resolved.file.path),
      "x-agent-session-path": encodeURIComponent(resolved.file.path),
    },
  });
}

export async function downloadAgentSessionAtif(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
) {
  const resolved = await resolveAgentSession(rawParams, herdrCall, files);
  if (!resolved.file) {
    return new Response(resolved.detail || "session file unavailable", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const records = await readRecords(resolved.file, files);
  const trajectory = projectAgentTrajectory(
    resolved.agent,
    resolved.file,
    records,
  );
  return new Response(`${JSON.stringify(trajectory, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": contentDispositionAtifFilename(resolved.file),
      "x-agent-session-path": encodeURIComponent(resolved.file.path),
    },
  });
}
