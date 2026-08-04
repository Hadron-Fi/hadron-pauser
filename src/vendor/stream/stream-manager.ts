import { loadYellowstoneClient } from "./yellowstone.js";
import { buildPingRequest } from "./subscriptions.js";
import type {
  GrpcStreamConfig,
  GrpcStreamCallbacks,
  GrpcEndpoint,
  KeepaliveMode,
} from "./types.js";

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_KEEPALIVE_MS = 30_000;
const DEFAULT_KEEPALIVE: KeepaliveMode = "client-ping";
const DEFAULT_FAILOVER_AFTER = 2;
const DEFAULT_MIN_STABLE_MS = 15_000;

/** Host of a URL, for a default endpoint label. Falls back to the raw string. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Manages a Yellowstone gRPC subscription with auto-reconnect, exponential
 * backoff, a keepalive ping, and — when more than one provider is configured —
 * automatic failover between providers.
 *
 * Reliability semantics are taken verbatim from the hadron-ingestor PRODUCER,
 * which has been extremely reliable in production:
 *
 *   1. error/end listeners are registered BEFORE the subscribe write, so an
 *      async stream error (e.g. "channel closed" from the Rust binding after a
 *      failed write) is handled here instead of escaping to
 *      `process.on("uncaughtException")` and crashlooping the container.
 *   2. a per-attempt `reconnectScheduled` guard makes error+end idempotent —
 *      whichever fires first schedules the single reconnect; the other is a no-op.
 *   3. the reconnect backoff is reset only once a subscribe is ACKNOWLEDGED
 *      (a genuinely healthy connection), not on every inbound message.
 *   4. the keepalive defaults to the unary `client.ping(1)` RPC (the producer's
 *      proven path); "stream-ping" is available for providers without that RPC.
 *
 * FAILOVER (multi-endpoint): after `failoverAfterFailures` consecutive failures on
 * the active provider the manager rotates to the next endpoint in the list, builds
 * a fresh client for it, and reconnects promptly (backoff reset to base). A
 * connection that ACKs then dies within `minStableMs` still counts toward failover,
 * so a flapping provider (ACK → immediate drop) is escaped rather than retried
 * forever. With `primaryRetryMs > 0`, while on a backup the manager periodically
 * re-probes the primary and returns to it once healthy.
 *
 * For a single endpoint the client is created once and REUSED across reconnects,
 * exactly as before — failover state stays inert.
 *
 * This class owns only the stream lifecycle. Crash-to-exit (so the orchestrator
 * restarts the process) and the broader health/heartbeat/alerting belong to the
 * service — pair this with `@hadron-fi/observability`'s `installCrashHandlers`
 * and `initObservability`.
 */
export class GrpcStreamManager {
  private client: any = null;
  private stream: any = null;
  private reconnectDelay: number;
  private isShuttingDown = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  private pingWarned = false;
  /** Per-attempt guard so a stream's error AND end don't both schedule a reconnect. */
  private reconnectScheduled = false;

  // --- failover state ---
  private readonly endpoints: GrpcEndpoint[];
  /** Index of the active endpoint in `endpoints`. */
  private currentIndex = 0;
  /** Which endpoint `this.client` was built for (-1 = none yet). */
  private clientIndex = -1;
  /** Consecutive failures on the active endpoint. */
  private failuresOnCurrent = 0;
  /** Last index reported via `onEndpointChange` (-1 = nothing reported yet). */
  private lastReportedIndex = -1;
  /** Set true after the first successful subscribe (distinguishes cold start from a reconnect). */
  private hasConnectedOnce = false;
  /** Epoch ms the stream went down, or null while healthy — drives ConnectInfo.downtimeMs. */
  private downSince: number | null = null;
  /** Endpoint index of the last healthy connection — drives ConnectInfo.failedOver. */
  private lastConnectedIndex = -1;

  // --- gap detection (only active when callbacks.slotOf is set) ---
  /** Highest slot seen via slotOf, persisted ACROSS reconnects so the resume gap is computable. */
  private maxSlot = 0;
  /** Set on disconnect; the first slot-bearing message on resume checks for a gap, then disarms. */
  private gapArmed = false;
  /** Downtime/failover of the in-flight gap, captured at ACK for the onGap that follows. */
  private lastDowntimeMs = 0;
  private lastFailedOver = false;
  private readonly gapThreshold: number;
  /** Keepalive mode resolved for the active endpoint (set on each connect). */
  private activeKeepalive: KeepaliveMode;
  /** Clears `failuresOnCurrent` once a connection survives `minStableMs`. */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-probes the primary while running on a backup (`primaryRetryMs`). */
  private primaryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly keepaliveMs: number;
  private readonly defaultKeepalive: KeepaliveMode;
  private readonly failoverAfterFailures: number;
  private readonly minStableMs: number;
  private readonly primaryRetryMs: number;

  constructor(
    private readonly config: GrpcStreamConfig,
    private readonly cb: GrpcStreamCallbacks,
  ) {
    const list =
      config.endpoints && config.endpoints.length > 0
        ? config.endpoints
        : config.endpoint
          ? [{ endpoint: config.endpoint, token: config.token, keepalive: config.keepalive }]
          : [];
    if (list.length === 0) {
      throw new Error(
        "GrpcStreamManager: no endpoint configured (pass `endpoint` or a non-empty `endpoints`)",
      );
    }
    this.endpoints = list.map((e) => ({ ...e, label: e.label ?? hostOf(e.endpoint) }));

    this.baseDelayMs = config.reconnectBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = config.reconnectMaxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.keepaliveMs = config.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    this.defaultKeepalive = config.keepalive ?? DEFAULT_KEEPALIVE;
    this.failoverAfterFailures = Math.max(1, config.failoverAfterFailures ?? DEFAULT_FAILOVER_AFTER);
    this.minStableMs = config.minStableMs ?? DEFAULT_MIN_STABLE_MS;
    this.primaryRetryMs = config.primaryRetryMs ?? 0;
    this.gapThreshold = config.gapThreshold ?? 5;

    this.reconnectDelay = this.baseDelayMs;
    this.activeKeepalive = this.endpoints[0].keepalive ?? this.defaultKeepalive;
  }

  /** Current backoff delay, surfaced for /health metrics. */
  getReconnectDelayMs(): number {
    return this.reconnectDelay;
  }

  /** True once a subscribe has been acknowledged and the stream is live. */
  isStreaming(): boolean {
    return this.stream != null;
  }

  /** The active failover endpoint, for /health metrics ({index, label}). */
  getActiveEndpoint(): { index: number; label: string } {
    return { index: this.currentIndex, label: this.endpoints[this.currentIndex].label! };
  }

  /**
   * Re-write the subscription on the ALREADY-OPEN stream — e.g. the watched
   * account set grew (a new market/pool registered) and you want it picked up
   * without tearing down the connection.
   *
   * Re-invokes `buildRequest()` and writes the result to the live stream. The
   * server replaces the active subscription in place (no reconnect, no missed
   * messages on the existing accounts). No-op if not currently streaming — the
   * next `connect()` rebuilds the request via `buildRequest()` anyway, so a
   * registration that races a reconnect is still reflected.
   *
   * The caller owns debouncing (registrations often arrive in bursts).
   */
  async resubscribe(): Promise<void> {
    if (this.isShuttingDown || !this.stream) return;
    const request = await this.cb.buildRequest();
    const stream = this.stream;
    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: Error | undefined) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Connect (or reconnect) and start streaming. Safe to call once; it self-heals after. */
  async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    // Fresh per-attempt state.
    this.reconnectScheduled = false;
    this.pingWarned = false;

    const ep = this.endpoints[this.currentIndex];
    this.activeKeepalive = ep.keepalive ?? this.defaultKeepalive;
    const tag = this.endpoints.length > 1 ? ` (${ep.label})` : "";

    try {
      console.log(`[grpc] connecting${tag}...`);

      // Create the client lazily and reuse it across reconnects (producer parity).
      // Rebuild it only when the active endpoint changed (failover / primary re-probe).
      // The Yellowstone Client has no close(); drop the ref and let GC reclaim the
      // channel (failover happens on the order of minutes, not ms).
      if (!this.client || this.clientIndex !== this.currentIndex) {
        this.client = null;
        const Client = await loadYellowstoneClient();
        this.client = new Client(ep.endpoint, ep.token, undefined);
        this.clientIndex = this.currentIndex;
      }

      await this.client.connect();
      this.stream = await this.client.subscribe();

      // Register error/end BEFORE the write. `reconnectScheduled` makes the two
      // idempotent — see the class doc comment.
      const fail = (reason: "error" | "end", label: string, err?: unknown): void => {
        if (this.isShuttingDown || this.reconnectScheduled) return;
        this.reconnectScheduled = true;
        this.markDown();
        if (err) console.error(`[grpc] ${label}:`, (err as Error).message);
        else console.warn(`[grpc] ${label}`);
        this.cb.onDisconnect?.(reason, err);
        this.cleanupStream();
        this.noteFailure();
        this.scheduleReconnect();
      };
      this.stream.on("error", (err: Error) => fail("error", "stream error", err));
      this.stream.on("end", () => fail("end", "stream ended unexpectedly"));

      const request = await this.cb.buildRequest();
      await new Promise<void>((resolve, reject) => {
        this.stream.write(request, (err: Error | undefined) =>
          err ? reject(err) : resolve(),
        );
      });

      // Subscribe acknowledged → healthy connection. Reset backoff here, NOT on
      // every data message (producer parity). The failure counter resets only once
      // the connection survives `minStableMs` (see armStableTimer) so a provider
      // that ACKs then immediately drops still trips failover.
      this.reconnectDelay = this.baseDelayMs;
      this.armStableTimer();
      this.maybeArmPrimaryRetry();
      console.log(`[grpc] subscription active${tag}`);

      this.stream.on("data", (data: any) => {
        if (this.cb.slotOf) this.trackSlot(data);
        try {
          this.cb.onData(data);
        } catch (err) {
          console.error("[grpc] handler error:", err);
        }
      });

      this.startKeepalive();

      // Hand the service a precise recovery window: how long we were down and whether
      // the provider changed. The service owns the actual backfill/reconcile.
      const firstConnect = !this.hasConnectedOnce;
      const downtimeMs = this.downSince != null ? Date.now() - this.downSince : 0;
      const failedOver = this.hasConnectedOnce && this.currentIndex !== this.lastConnectedIndex;
      // Stash for the onGap that the first post-resume slot will fire (downSince is
      // cleared here, so capture the window now).
      this.lastDowntimeMs = downtimeMs;
      this.lastFailedOver = failedOver;
      this.downSince = null;
      this.hasConnectedOnce = true;
      this.lastConnectedIndex = this.currentIndex;
      this.cb.onConnect?.({
        firstConnect,
        downtimeMs,
        failedOver,
        endpoint: { index: this.currentIndex, label: ep.label! },
      });
      this.reportEndpoint();
    } catch (err) {
      // A connect-time failure (no stream handlers attached yet) — the error/end
      // path can't also fire, so call scheduleReconnect directly.
      this.markDown();
      console.error("[grpc] connect failed:", err);
      this.cb.onDisconnect?.("connect-failed", err);
      this.cleanupStream();
      this.noteFailure();
      this.scheduleReconnect();
    }
  }

  /** Mark the stream as down: start the downtime clock and arm gap detection. */
  private markDown(): void {
    if (this.downSince === null) this.downSince = Date.now();
    // Only arm a gap once we've had a healthy stream — a cold-start "gap" from slot 0
    // is the service's job (it knows its persisted checkpoint), not ours.
    if (this.hasConnectedOnce) this.gapArmed = true;
  }

  /** Track the max slot seen and, on the first slot after a resume, detect a gap. */
  private trackSlot(data: any): void {
    const slot = this.cb.slotOf!(data);
    if (slot == null || !Number.isFinite(slot) || slot <= 0) return;
    if (this.gapArmed) {
      // First slot-bearing message since the stream resumed — disarm regardless.
      this.gapArmed = false;
      if (this.maxSlot > 0 && slot > this.maxSlot + this.gapThreshold) {
        this.cb.onGap?.({
          fromSlot: this.maxSlot + 1,
          toSlot: slot - 1,
          downtimeMs: this.lastDowntimeMs,
          failedOver: this.lastFailedOver,
        });
      }
    }
    if (slot > this.maxSlot) this.maxSlot = slot;
  }

  /**
   * Account one failure on the active endpoint and, once the threshold is reached,
   * rotate to the next provider. No-op with a single endpoint.
   */
  private noteFailure(): void {
    if (this.isShuttingDown || this.endpoints.length < 2) return;
    this.clearStableTimer();
    this.failuresOnCurrent++;
    if (this.failuresOnCurrent < this.failoverAfterFailures) return;

    const from = this.endpoints[this.currentIndex].label;
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    this.failuresOnCurrent = 0;
    this.reconnectDelay = this.baseDelayMs; // try the new provider promptly
    this.clearPrimaryTimer();
    console.warn(
      `[grpc] failing over: ${from} → ${this.endpoints[this.currentIndex].label}`,
    );
  }

  /** Reset the failure counter once the active connection has been stable for minStableMs. */
  private armStableTimer(): void {
    if (this.endpoints.length < 2) return;
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.failuresOnCurrent = 0;
    }, this.minStableMs);
  }

  /** While on a backup, schedule a re-probe of the primary (primaryRetryMs). */
  private maybeArmPrimaryRetry(): void {
    this.clearPrimaryTimer();
    if (this.primaryRetryMs <= 0 || this.currentIndex === 0 || this.endpoints.length < 2) return;
    this.primaryTimer = setTimeout(() => {
      if (this.isShuttingDown || this.currentIndex === 0) return;
      console.log(`[grpc] re-probing primary (${this.endpoints[0].label})...`);
      this.currentIndex = 0;
      this.failuresOnCurrent = 0;
      this.reconnectDelay = this.baseDelayMs;
      this.markDown();
      // Tear down the current (working) backup stream and reconnect to the primary.
      // If the primary fails again, noteFailure() rotates back to the backup.
      this.reconnectScheduled = true; // suppress the old stream's end handler
      this.cleanupStream();
      void this.connect();
    }, this.primaryRetryMs);
  }

  private reportEndpoint(): void {
    if (this.currentIndex === this.lastReportedIndex) return;
    this.lastReportedIndex = this.currentIndex;
    const ep = this.endpoints[this.currentIndex];
    this.cb.onEndpointChange?.({ index: this.currentIndex, label: ep.label! });
  }

  private startKeepalive(): void {
    if (this.activeKeepalive === "none" || this.keepaliveMs <= 0) return;
    this.pingInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      void this.sendKeepalive();
    }, this.keepaliveMs);
  }

  private async sendKeepalive(): Promise<void> {
    try {
      if (this.activeKeepalive === "client-ping") {
        if (this.client) await this.client.ping(1);
      } else if (this.activeKeepalive === "stream-ping") {
        if (this.stream) {
          this.stream.write(buildPingRequest(++this.pingId), (err: Error | undefined) => {
            if (err) this.onPingError(err);
          });
        }
      }
    } catch (err) {
      this.onPingError(err);
    }
  }

  private onPingError(err: unknown): void {
    if (this.isShuttingDown) return;
    this.cb.onKeepaliveError?.(err);
    // Warn at most once per connection — a genuinely dead stream reconnects via
    // the error/end handlers; we don't want a flapping ping to spam stderr.
    if (!this.pingWarned) {
      this.pingWarned = true;
      console.warn(
        `[grpc] keepalive ping failed (suppressing until reconnect): ${(err as Error).message}`,
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelayMs);
    console.log(`[grpc] reconnecting in ${delay}ms...`);
    setTimeout(() => void this.connect(), delay);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearPrimaryTimer(): void {
    if (this.primaryTimer) {
      clearTimeout(this.primaryTimer);
      this.primaryTimer = null;
    }
  }

  /** Tear down the current stream + keepalive. Keeps the client for reuse. */
  private cleanupStream(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.stream) {
      try {
        // Detach listeners first so a late error/end from THIS stream can't drive a
        // second reconnect after we've already moved on (matters for failover, where
        // the next connect() may start before the old stream finishes ending).
        this.stream.removeAllListeners?.();
        // ...but 'error' is special in Node: an EventEmitter with NO 'error' listener
        // THROWS on emit, taking the process down. A retired gRPC duplex stream very
        // commonly emits one more error right here — `end()` on a stream whose remote
        // half was reset surfaces as `subscribe stream receive failed`
        // (h2 `Reset(StreamId(N), INTERNAL_ERROR, Remote)`). Before this guard that
        // crashed the crank ~4x/82h on hadron-crank-msol and killed the mSOL Phase-2
        // soak twice. Re-attach a swallowing listener: it keeps the "don't drive a
        // second reconnect" intent (the handler does nothing) while making the emit safe.
        this.stream.on?.("error", () => {});
        this.stream.end();
      } catch {
        // ignore
      }
      this.stream = null;
    }
  }

  /** Permanently stop the manager (no further reconnects). */
  shutdown(): void {
    this.isShuttingDown = true;
    this.clearStableTimer();
    this.clearPrimaryTimer();
    this.cleanupStream();
    this.client = null;
    console.log("[grpc] stream manager shut down");
  }
}
