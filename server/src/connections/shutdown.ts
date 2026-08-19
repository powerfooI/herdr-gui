type ShutdownControllerOptions = {
  stop: () => void | Promise<void>;
  exit: (code: number) => void;
  onStopError?: (error: unknown) => void;
  timeoutMs?: number;
  scheduleForceExit?: (callback: () => void, timeoutMs: number) => () => void;
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function scheduleForceExit(callback: () => void, timeoutMs: number) {
  const timer = setTimeout(callback, timeoutMs);
  return () => clearTimeout(timer);
}

export function createShutdownController(options: ShutdownControllerOptions) {
  let shutdownTask: Promise<void> | null = null;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };

  return {
    request(exitCode: number): Promise<void> {
      if (shutdownTask) return shutdownTask;
      shutdownTask = (async () => {
        const cancelForceExit = (
          options.scheduleForceExit ?? scheduleForceExit
        )(
          () => exitOnce(exitCode),
          options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        );
        try {
          await options.stop();
        } catch (error) {
          try {
            options.onStopError?.(error);
          } catch (observerError) {
            console.error(
              "[bridge] shutdown error observer failed:",
              observerError,
            );
          }
        } finally {
          cancelForceExit();
          exitOnce(exitCode);
        }
      })();
      return shutdownTask;
    },
  };
}
