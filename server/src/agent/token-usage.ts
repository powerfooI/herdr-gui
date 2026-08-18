import type { AtifMetrics, TokenUsage } from "./session-types";
import { isRecord, numberValue } from "./session-utils";

export function tokenUsageFrom(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const piInput = numberValue(value.input);
  const piCacheWrite = numberValue(value.cacheWrite);
  const kimiInput =
    numberValue(value.inputOther) ?? numberValue(value.input_other);
  const kimiCacheCreation =
    numberValue(value.inputCacheCreation) ??
    numberValue(value.input_cache_creation);
  const kimiCachedInput =
    numberValue(value.inputCacheRead) ?? numberValue(value.input_cache_read);
  const kimiOutput = numberValue(value.output);
  const usage: TokenUsage = {
    input_tokens:
      numberValue(value.input_tokens) ??
      numberValue(value.inputTokens) ??
      numberValue(value.prompt_tokens) ??
      numberValue(value.promptTokens) ??
      (piInput !== undefined || piCacheWrite !== undefined
        ? (piInput ?? 0) + (piCacheWrite ?? 0)
        : undefined) ??
      (kimiInput !== undefined || kimiCacheCreation !== undefined
        ? (kimiInput ?? 0) + (kimiCacheCreation ?? 0)
        : undefined),
    cached_input_tokens:
      numberValue(value.cached_input_tokens) ??
      numberValue(value.cache_read_input_tokens) ??
      numberValue(value.cacheReadInputTokens) ??
      numberValue(value.cacheRead) ??
      kimiCachedInput,
    output_tokens:
      numberValue(value.output_tokens) ??
      numberValue(value.outputTokens) ??
      numberValue(value.completion_tokens) ??
      numberValue(value.completionTokens) ??
      kimiOutput,
    reasoning_output_tokens:
      numberValue(value.reasoning_output_tokens) ??
      numberValue(value.reasoningOutputTokens) ??
      numberValue(value.reasoning),
    total_tokens:
      numberValue(value.total_tokens) ??
      numberValue(value.totalTokens) ??
      numberValue(value.tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0) || undefined,
    cached_input_tokens:
      (a.cached_input_tokens ?? 0) + (b.cached_input_tokens ?? 0) || undefined,
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0) || undefined,
    reasoning_output_tokens:
      (a.reasoning_output_tokens ?? 0) + (b.reasoning_output_tokens ?? 0) ||
      undefined,
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0) || undefined,
  };
}

export function tokenUsageToMetrics(
  usage: TokenUsage | null,
): AtifMetrics | undefined {
  if (!usage) return undefined;
  const metrics: AtifMetrics = {};
  if (usage.input_tokens !== undefined)
    metrics.prompt_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) {
    metrics.completion_tokens = usage.output_tokens;
  }
  if (usage.cached_input_tokens !== undefined) {
    metrics.cached_tokens = usage.cached_input_tokens;
  }
  const extra: Record<string, unknown> = {};
  if (usage.reasoning_output_tokens !== undefined) {
    extra.reasoning_output_tokens = usage.reasoning_output_tokens;
  }
  if (usage.total_tokens !== undefined) extra.total_tokens = usage.total_tokens;
  if (Object.keys(extra).length > 0) metrics.extra = extra;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function tokenUsageForRecord(record: Record<string, unknown>): {
  usage: TokenUsage | null;
  cumulative: boolean;
} {
  if (
    record.type === "event_msg" &&
    isRecord(record.payload) &&
    record.payload.type === "token_count" &&
    isRecord(record.payload.info)
  ) {
    return {
      usage: tokenUsageFrom(record.payload.info.total_token_usage),
      cumulative: true,
    };
  }
  const candidates = [
    record.usage,
    isRecord(record.message) ? record.message.usage : undefined,
    isRecord(record.payload) ? record.payload.usage : undefined,
  ];
  for (const candidate of candidates) {
    const usage = tokenUsageFrom(candidate);
    if (usage) return { usage, cumulative: false };
  }
  return { usage: null, cumulative: false };
}

export function summarizeTokenUsage(records: Record<string, unknown>[]) {
  let cumulative: TokenUsage | null = null;
  let summed: TokenUsage = {};
  for (const record of records) {
    const next = tokenUsageForRecord(record);
    if (!next.usage) continue;
    if (next.cumulative) {
      cumulative = next.usage;
    } else {
      summed = addTokenUsage(summed, next.usage);
    }
  }
  return cumulative ?? (Object.values(summed).some(Boolean) ? summed : null);
}
