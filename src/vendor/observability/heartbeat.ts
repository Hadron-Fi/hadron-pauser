export interface HeartbeatOptions {
  /**
   * Dead-man's-switch URL (e.g. a healthchecks.io ping URL). When unset, the
   * heartbeat is a no-op and `startHeartbeat` returns immediately.
   */
  url?: string;
  /** Ping interval. Default 60_000. */
  intervalMs?: number;
  /**
   * When provided and it returns false, the heartbeat pings `${url}/fail`
   * instead of `${url}` so the monitor records an explicit failure signal.
   */
  getIsHealthy?: () => boolean;
  /** Per-ping timeout. Default 10_000. */
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Start pinging a dead-man's-switch on an interval. The monitor alerts when the
 * pings stop (process hung/crashed) — catching failures a /health poll can miss
 * because the container still appears up. Returns a stop function.
 */
export function startHeartbeat(opts: HeartbeatOptions): () => void {
  const url = opts.url;
  if (!url) return () => {};

  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const ping = async () => {
    const healthy = opts.getIsHealthy ? opts.getIsHealthy() : true;
    const target = healthy ? url : `${url.replace(/\/$/, "")}/fail`;
    try {
      await fetch(target, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const timer = setInterval(() => void ping(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void ping(); // fire once immediately

  return () => clearInterval(timer);
}
