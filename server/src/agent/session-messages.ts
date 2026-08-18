import type {
  AgentMessageHistoryEntry,
  AtifStep,
  AtifTrajectory,
  SessionFile,
} from "./session-types";
import { stableMessageId } from "./session-utils";

function isConversationStep(step: AtifStep) {
  if (step.source === "user") return step.message.trim().length > 0;
  if (step.source !== "agent" || !step.message.trim()) return false;

  // ATIF also represents reasoning, tool calls, errors, and token accounting as
  // agent steps. Messages should remain a readable conversation transcript,
  // so only retain text that the agent actually presented as its response.
  if (step.metrics && step.message === "Token usage") return false;
  if (step.reasoning_content && step.message === "Reasoning") return false;
  if (step.tool_calls?.length && /^Tool calls?:/.test(step.message))
    return false;
  if (step.extra?.error_message && step.message.startsWith("Error:"))
    return false;
  return true;
}

export function conversationMessagesFromTrajectory(
  file: SessionFile,
  trajectory: AtifTrajectory,
): AgentMessageHistoryEntry[] {
  return trajectory.steps.filter(isConversationStep).map((step) => ({
    id: stableMessageId(file.path, step.step_id),
    role: step.source === "user" ? "user" : "assistant",
    text: step.message,
    sent_at:
      step.timestamp ??
      new Date(file.mtimeMs + Math.max(0, step.step_id)).toISOString(),
  }));
}
