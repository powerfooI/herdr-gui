/**
 * Focus-style actions (workspace/tab/pane switches) fired while the bridge
 * socket is reconnecting fail before reaching the server. These errors are
 * safe to retry once the connection is back because the underlying Herdr
 * focus calls are idempotent.
 */
const RECONNECT_RETRYABLE_ERROR =
  /not connected to bridge|bridge hello is unavailable|connection runtime generation is unavailable|connection changed during request|bridge disconnected|bridge connection timed out|bridge hello timed out/;

export function isReconnectRetryableError(error: Error): boolean {
  return RECONNECT_RETRYABLE_ERROR.test(error.message);
}
