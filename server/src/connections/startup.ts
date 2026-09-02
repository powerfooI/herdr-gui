import { serverLogger } from "../utils/logger";

export function bindListenerBeforeConnectionStart<Listener>(args: {
  bindListener: () => Listener;
  startConnection: () => void | Promise<void>;
  onConnectionError: (error: unknown) => void;
}): Listener {
  const listener = args.bindListener();
  const reportConnectionError = (error: unknown) => {
    try {
      args.onConnectionError(error);
    } catch (observerError) {
      serverLogger
        .child("connections")
        .error("connection startup error observer failed", {
          error: observerError,
        });
    }
  };
  try {
    void Promise.resolve(args.startConnection()).catch(reportConnectionError);
  } catch (error) {
    reportConnectionError(error);
  }
  return listener;
}
