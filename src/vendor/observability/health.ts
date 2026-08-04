import { createServer, type Server } from "node:http";

/**
 * Free-form origin label for a broken-log entry, e.g. "grpc" | "rpc" | "process".
 */
export type BrokenLogSource = string;

export interface BrokenLogEntry {
  at: string;
  source: BrokenLogSource;
  event: string;
  message: string;
}

/**
 * A boolean liveness check. The service is only `live` when ALL declared checks
 * are true. Pass a bare string to use a default reason of `not_<name>`, or an
 * object to control the reason surfaced when the check is false.
 */
export type LivenessCheck = string | { name: string; reasonWhenDown?: string };

/**
 * A freshness check: once data for `name` has been seen (via `markFresh`), it
 * must continue to arrive within `staleMs` for the service to stay live. Before
 * the first `markFresh`, the check is considered stale (data has never arrived).
 */
export interface FreshnessCheck {
  name: string;
  staleMs: number;
  reasonWhenStale?: string;
}

export interface HealthServerOptions {
  /** Service name, surfaced in the /health body. */
  service: string;
  cluster?: string;
  port: number;
  livenessChecks?: LivenessCheck[];
  freshness?: FreshnessCheck[];
  /** Extra fields merged into the `metrics` object on every /health response. */
  getMetrics?: () => Record<string, unknown>;
  getIsShuttingDown?: () => boolean;
  /** Ring-buffer size for the broken log. Default 25. */
  brokenLogLimit?: number;
  /** Set false to skip the startup log line. Default true. */
  log?: boolean;
}

export interface HealthSnapshot {
  status: "ok" | "broken";
  live: boolean;
  reasons: string[];
}

export interface HealthServer {
  /** Set a boolean liveness check (e.g. `setStatus("grpc_connected", true)`). */
  setStatus(name: string, ok: boolean): void;
  /** Record that fresh data for `name` just arrived (resets its staleness timer). */
  markFresh(name: string): void;
  /** Append a broken-log entry (oldest dropped past the ring-buffer limit). */
  recordBroken(source: BrokenLogSource, event: string, err?: unknown): void;
  /** Current liveness without hitting HTTP — used by heartbeat / alerting. */
  snapshot(): HealthSnapshot;
  /** Most recent broken-log entries (newest last). */
  brokenLog(): readonly BrokenLogEntry[];
  close(): void;
}

function normalizeChecks(checks: LivenessCheck[]): { name: string; reasonWhenDown: string }[] {
  return checks.map((c) =>
    typeof c === "string"
      ? { name: c, reasonWhenDown: `not_${c}` }
      : { name: c.name, reasonWhenDown: c.reasonWhenDown ?? `not_${c.name}` }
  );
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const startedAt = Date.now();
  const brokenLogLimit = options.brokenLogLimit ?? 25;
  const log = options.log ?? true;

  const checkDefs = normalizeChecks(options.livenessChecks ?? []);
  const freshnessDefs = options.freshness ?? [];

  const checks = new Map<string, boolean>();
  for (const c of checkDefs) checks.set(c.name, false);

  const lastFreshAt = new Map<string, number | null>();
  for (const f of freshnessDefs) lastFreshAt.set(f.name, null);

  const brokenLogEntries: BrokenLogEntry[] = [];

  function evaluate(now: number): {
    live: boolean;
    reasons: string[];
    checksOut: Record<string, boolean>;
    freshnessMetrics: Record<string, unknown>;
  } {
    const reasons: string[] = [];
    const checksOut: Record<string, boolean> = {};

    for (const def of checkDefs) {
      const ok = checks.get(def.name) ?? false;
      checksOut[def.name] = ok;
      if (!ok) reasons.push(def.reasonWhenDown);
    }

    const freshnessMetrics: Record<string, unknown> = {};
    for (const f of freshnessDefs) {
      const at = lastFreshAt.get(f.name) ?? null;
      const fresh = at !== null && now - at <= f.staleMs;
      checksOut[`${f.name}_fresh`] = fresh;
      freshnessMetrics[`${f.name}_at`] = at ? new Date(at).toISOString() : null;
      freshnessMetrics[`${f.name}_stale_threshold_ms`] = f.staleMs;
      if (!fresh) reasons.push(f.reasonWhenStale ?? `${f.name}_stale`);
    }

    const shuttingDown = options.getIsShuttingDown?.() ?? false;
    if (shuttingDown) reasons.push("shutting_down");

    return { live: reasons.length === 0, reasons, checksOut, freshnessMetrics };
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" || !req.url || !req.url.startsWith("/health")) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const now = Date.now();
    const { live, reasons, checksOut, freshnessMetrics } = evaluate(now);

    res.statusCode = live ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: live ? "ok" : "broken",
        live,
        service: options.service,
        cluster: options.cluster,
        now: new Date(now).toISOString(),
        uptimeSec: Math.floor((now - startedAt) / 1000),
        checks: checksOut,
        metrics: {
          ...freshnessMetrics,
          ...(options.getMetrics?.() ?? {}),
        },
        reasons,
        brokenLog: brokenLogEntries,
      })
    );
  });

  server.listen(options.port, () => {
    if (log) {
      console.log(
        `[observability] health endpoint listening on :${options.port} (/health)`
      );
    }
  });

  return {
    setStatus(name, ok) {
      checks.set(name, ok);
    },
    markFresh(name) {
      lastFreshAt.set(name, Date.now());
    },
    recordBroken(source, event, err) {
      const message =
        err instanceof Error
          ? err.message
          : err == null
            ? "unknown error"
            : String(err);
      brokenLogEntries.push({
        at: new Date().toISOString(),
        source,
        event,
        message,
      });
      while (brokenLogEntries.length > brokenLogLimit) brokenLogEntries.shift();
    },
    snapshot() {
      const { live, reasons } = evaluate(Date.now());
      return { status: live ? "ok" : "broken", live, reasons };
    },
    brokenLog() {
      return brokenLogEntries;
    },
    close() {
      server.close();
    },
  };
}
