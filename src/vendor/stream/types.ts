/** Keepalive mechanism for the gRPC stream. */
export type KeepaliveMode =
  /**
   * Unary `client.ping(1)` RPC. This is the hadron-ingestor producer's proven
   * path and the default. Some providers don't expose this RPC — use
   * "stream-ping" there.
   */
  | "client-ping"
  /**
   * Write a ping-only SubscribeRequest on the existing stream; the server
   * replies with a pong (which flows through `onData`, keeping freshness checks
   * green) without altering the subscription. Portable across providers.
   */
  | "stream-ping"
  /** No keepalive. */
  | "none";

/**
 * One gRPC provider in a failover list. The `label` is for logs / `/health`; the
 * `keepalive` override exists because not every provider exposes the unary
 * `client.ping` RPC (use "stream-ping" there).
 */
export interface GrpcEndpoint {
  /** Yellowstone gRPC endpoint URL. */
  endpoint: string;
  /** Auth token (x-token) for the endpoint. Maps to the producer's `GRPC_API_KEY`. */
  token?: string;
  /** Human label for logs / health (e.g. "alchemy", "triton"). Defaults to the URL host. */
  label?: string;
  /** Per-endpoint keepalive override. Falls back to the top-level `keepalive`. */
  keepalive?: KeepaliveMode;
}

/** Stream manager configuration. Defaults match the hadron-ingestor producer. */
export interface GrpcStreamConfig {
  /**
   * Single-endpoint shorthand (back-compat). Use `endpoints` for failover. If both
   * are given, `endpoints` wins.
   */
  endpoint?: string;
  /** Auth token (x-token) for `endpoint`. Maps to the producer's `GRPC_API_KEY`. */
  token?: string;
  /**
   * Ordered failover list, primary first. When more than one is given the manager
   * rotates to the next provider after `failoverAfterFailures` consecutive failures
   * on the active one. Build it from env with `endpointsFromEnv()`.
   */
  endpoints?: GrpcEndpoint[];
  /**
   * Consecutive failures on the active endpoint before rotating to the next.
   * Default 2. Ignored with a single endpoint.
   */
  failoverAfterFailures?: number;
  /**
   * A connection that subscribes then dies within this window still counts toward
   * failover (catches providers that ACK then immediately drop). The failure
   * counter only resets after the stream survives this long. Default 15_000.
   */
  minStableMs?: number;
  /**
   * When running on a non-primary endpoint, re-probe the primary after this many ms
   * and switch back if it's healthy. 0 = stay on the working backup, never auto-return.
   * Default 0.
   */
  primaryRetryMs?: number;
  /**
   * Base reconnect backoff in ms. The delay is reset to this once a subscribe is
   * acknowledged (a healthy connection). Default 1000.
   */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect backoff in ms. Default 60_000. */
  reconnectMaxDelayMs?: number;
  /** Keepalive interval in ms. Default 30_000. */
  keepaliveIntervalMs?: number;
  /** Default keepalive mechanism (per-endpoint `keepalive` overrides it). Default "client-ping". */
  keepalive?: KeepaliveMode;
  /**
   * Slots the resumed stream may jump ahead of the last-seen slot without it
   * counting as a gap — Solana skips empty slots normally. Default 5. Only used
   * when `slotOf`/`onGap` are provided.
   */
  gapThreshold?: number;
}

/**
 * Context handed to `onConnect` on every successful (re)subscribe. Lets a service
 * decide how hard to work on recovery: skip a reconcile after a 1s blip, run a deep
 * RPC backfill/reconcile after a multi-minute outage, and know whether it just landed
 * on a different provider. The manager handles the connection; the SERVICE owns the
 * actual gap recovery (slot-range backfill or account reconcile) — this just gives it
 * a precise trigger + window.
 */
export interface ConnectInfo {
  /** First successful connect of this process (cold start — nothing to backfill from a prior stream). */
  firstConnect: boolean;
  /** Wall-clock ms the stream was down before this (re)connect. 0 on the first connect. */
  downtimeMs: number;
  /** True when this connect landed on a different provider than the last healthy one (failover or primary re-probe). */
  failedOver: boolean;
  /** The now-active endpoint. */
  endpoint: { index: number; label: string };
}

/**
 * A detected slot gap: the stream resumed past the last slot it had seen, so the
 * slots in between were missed while down. The SERVICE acts on this — publish a gap
 * marker, RPC-backfill the range, etc. Both bounds are inclusive.
 */
export interface GapInfo {
  /** First slot believed missed (last-seen slot + 1). */
  fromSlot: number;
  /** Last slot believed missed (first slot after resume − 1). */
  toSlot: number;
  /** Wall-clock ms the stream was down across this gap. */
  downtimeMs: number;
  /** True if the resume landed on a different provider than before the gap. */
  failedOver: boolean;
}

export interface GrpcStreamCallbacks {
  /**
   * Build the SubscribeRequest. Called fresh on every (re)connect so the request
   * always reflects current config. Use `buildSubscribeRequest(...)` to compose it.
   */
  buildRequest: () => unknown | Promise<unknown>;
  /** Called for every stream message (account / slot / transaction / pong). */
  onData: (data: any) => void;
  /**
   * Called once a subscribe request is acknowledged — on the initial connect and
   * after every reconnect/failover. The place to (re)run a reconciliation sweep or
   * reset per-connection state (e.g. gap-detection slot tracking). The `ConnectInfo`
   * tells you how long the stream was down and whether the provider changed, so you
   * can scale recovery to the actual downtime. The arg is optional — existing
   * zero-arg handlers keep working.
   */
  onConnect?: (info: ConnectInfo) => void;
  /**
   * Called when the stream errors/ends or a connect attempt fails. `reason` is
   * "error" | "end" | "connect-failed". Transient — the manager schedules its own
   * reconnect; use this to flip health state / log, not to reconnect yourself.
   */
  onDisconnect?: (reason: string, err?: unknown) => void;
  /**
   * Called on the initial connect and whenever the active failover endpoint changes
   * (failover to a backup, or re-probe back to the primary). Use it to surface the
   * active provider in `/health` and to alert when running on a non-primary endpoint
   * (`index > 0`). Only fires on an actual change, not on every reconnect.
   */
  onEndpointChange?: (active: { index: number; label: string }) => void;
  /**
   * Called when a keepalive ping fails. Non-fatal: a genuinely dead stream
   * surfaces via the error/end handlers, which drive the reconnect. Wire this to
   * your broken-log if you want visibility. Defaults to a one-shot stderr warning.
   */
  onKeepaliveError?: (err: unknown) => void;
  /**
   * Extract the Solana slot from a stream message, or undefined if it carries none
   * (e.g. a pong). Enables SDK-side gap detection: the manager tracks the max slot
   * seen — persisted ACROSS reconnects — and fires `onGap` when the stream resumes
   * past it by more than `gapThreshold`. Without this, no slot tracking happens
   * (behaviour unchanged).
   *
   * Prefer a DENSE, MONOTONIC source (e.g. return a slot only for slot updates, not
   * for every account/txn message) so the first value seen on resume is the true
   * resume slot — that makes gap detection exact rather than racing out-of-order
   * account/txn slots.
   */
  slotOf?: (data: any) => number | undefined;
  /**
   * Called at most once per reconnect, when the first slot seen on resume jumps
   * past the last-seen slot by more than `gapThreshold` — i.e. slots were missed
   * while the stream was down. Requires `slotOf`. The service acts on the range
   * (publish a gap marker / RPC backfill). Not fired on cold start (there's no prior
   * slot — handle startup gaps yourself, e.g. from a persisted checkpoint).
   */
  onGap?: (gap: GapInfo) => void;
}
