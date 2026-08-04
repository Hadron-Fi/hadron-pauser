export interface CrashHandlerOptions {
  /** Invoked for both uncaughtException and unhandledRejection. */
  onError: (source: "process", event: string, err: unknown) => void;
  /**
   * Exit the process after recording. Default false — long-running workers with
   * their own reconnect/supervision usually prefer to stay up and let the
   * health endpoint + heartbeat report the degradation.
   */
  exit?: boolean;
  /** Delay before exit (ms) to let async record/alert flush. Default 1000. */
  exitDelayMs?: number;
}

/**
 * Install process-level crash handlers that funnel uncaught errors into
 * `onError` (typically `recordBroken`). Returns a disposer that removes them.
 */
export function installCrashHandlers(opts: CrashHandlerOptions): () => void {
  const exitDelayMs = opts.exitDelayMs ?? 1000;

  const maybeExit = () => {
    if (!opts.exit) return;
    setTimeout(() => process.exit(1), exitDelayMs).unref();
  };

  const onUncaught = (err: unknown) => {
    opts.onError("process", "uncaughtException", err);
    maybeExit();
  };
  const onRejection = (reason: unknown) => {
    opts.onError("process", "unhandledRejection", reason);
    maybeExit();
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
}
