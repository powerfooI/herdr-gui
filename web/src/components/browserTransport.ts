import type { ConnectionStatus } from "../api";

export interface BrowserTransportPresentation {
  label: string;
  clientCount: number | null;
  pauseOthersLabel: string | null;
  needsResume: boolean;
  toggleLabel: string;
}

export function browserTransportPresentation(
  connectionPaused: boolean,
  status: ConnectionStatus,
  reportedClientCount: number | null | undefined,
): BrowserTransportPresentation {
  let label = "Browser disconnected from bridge";
  if (connectionPaused) {
    label = "Browser sync paused";
  } else if (status === "connected") {
    label = "Browser connected to bridge";
  } else if (status === "connecting") {
    label = "Browser connecting to bridge";
  }
  const clientCount =
    !connectionPaused && status === "connected"
      ? (reportedClientCount ?? null)
      : null;
  const otherClientCount =
    typeof clientCount === "number" ? Math.max(0, clientCount - 1) : 0;
  let pauseOthersLabel: string | null = null;
  if (otherClientCount === 1) {
    pauseOthersLabel = "Pause other browser";
  } else if (otherClientCount > 1) {
    pauseOthersLabel = `Pause other browsers (${otherClientCount})`;
  }
  const needsResume = connectionPaused || status === "disconnected";
  let toggleLabel = "Pause browser sync";
  if (connectionPaused) {
    toggleLabel = "Resume browser sync";
  } else if (status === "disconnected") {
    toggleLabel = "Reconnect browser";
  }

  return {
    label,
    clientCount,
    pauseOthersLabel,
    needsResume,
    toggleLabel,
  };
}
