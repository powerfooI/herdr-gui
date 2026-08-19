export const LEGACY_DEFAULT_CONNECTION_ID = "legacy-default";

export type ConnectionId = string;

export type ConnectionIdentity = {
  id: ConnectionId;
  label: string;
  source: string;
};

export type LegacyConnectionIdentity = ConnectionIdentity & {
  id: typeof LEGACY_DEFAULT_CONNECTION_ID;
  label: "Default";
  source: "legacy-config";
};

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "stopping"
  | "error";

export type ConnectionStatus = {
  id: ConnectionId;
  label: string;
  source: string;
  is_default: boolean;
  state: ConnectionState;
  generation: number;
  error?: {
    message: string;
  };
};

export const LEGACY_DEFAULT_CONNECTION: LegacyConnectionIdentity = {
  id: LEGACY_DEFAULT_CONNECTION_ID,
  label: "Default",
  source: "legacy-config",
};
