import {
  createHealthServer,
  type HealthServer,
  type HealthServerOptions,
  type BrokenLogSource,
} from "./health.js";
import { installCrashHandlers } from "./crash.js";
import { startHeartbeat } from "./heartbeat.js";
import { createSlackAlerter, type SlackAlerter } from "./slack.js";

export interface ObservabilityOptions {
  service: string;
  cluster?: string;
  /** Health server config. Omit `service`/`cluster` — inherited from the top level. */
  health: Omit<HealthServerOptions, "service" | "cluster">;
  slackWebhookUrl?: string;
  /** Slack bot token (`xoxb-…`). With `slackChannel`, enables threaded delivery via chat.postMessage. */
  slackBotToken?: string;
  /** Channel id/name for bot-token delivery (required when `slackBotToken` is set). */
  slackChannel?: string;
  /** Dead-man's-switch ping URL (e.g. healthchecks.io). */
  heartbeatUrl?: string;
  heartbeatIntervalMs?: number;
  /** Drives `live` and stops heartbeat fail-pings during shutdown. */
  getIsShuttingDown?: () => boolean;
  /** Install uncaughtException/unhandledRejection handlers. Default true. */
  installCrashHandlers?: boolean;
  /** Exit the process on an uncaught error. Default false. */
  exitOnUncaught?: boolean;
  /** Dedupe window for self-alerts. Default 60_000. */
  alertMinIntervalMs?: number;
}

export interface Observability {
  health: HealthServer;
  slack: SlackAlerter;
  /**
   * Record a degradation: appends to the health broken-log AND fires a
   * (deduped) Slack alert. This is what crash handlers and your error paths
   * should call.
   */
  recordBroken(source: BrokenLogSource, event: string, err?: unknown): void;
  /** Stop heartbeat, remove crash handlers, and close the health server. */
  stop(): void;
}

/**
 * Wire the full observability kit for a worker service: a /health endpoint,
 * crash handlers, a dead-man's-switch heartbeat, and Slack self-alerts.
 */
export function initObservability(opts: ObservabilityOptions): Observability {
  const getIsShuttingDown = opts.getIsShuttingDown;

  const health = createHealthServer({
    service: opts.service,
    cluster: opts.cluster,
    getIsShuttingDown,
    ...opts.health,
  });

  const slack = createSlackAlerter({
    webhookUrl: opts.slackWebhookUrl,
    botToken: opts.slackBotToken,
    channel: opts.slackChannel,
    service: opts.service,
    cluster: opts.cluster,
    minIntervalMs: opts.alertMinIntervalMs,
  });

  const recordBroken = (source: BrokenLogSource, event: string, err?: unknown) => {
    health.recordBroken(source, event, err);
    const detail =
      err instanceof Error ? ` — ${err.message}` : err == null ? "" : ` — ${String(err)}`;
    void slack.alert(`:rotating_light: ${source}/${event}${detail}`, {
      key: `${source}:${event}`,
    });
  };

  const removeCrashHandlers =
    (opts.installCrashHandlers ?? true)
      ? installCrashHandlers({ onError: recordBroken, exit: opts.exitOnUncaught })
      : () => {};

  const stopHeartbeat = startHeartbeat({
    url: opts.heartbeatUrl,
    intervalMs: opts.heartbeatIntervalMs,
    getIsHealthy: () => !(getIsShuttingDown?.() ?? false) && health.snapshot().live,
    onError: (err) => health.recordBroken("heartbeat", "ping-failed", err),
  });

  return {
    health,
    slack,
    recordBroken,
    stop() {
      stopHeartbeat();
      removeCrashHandlers();
      health.close();
    },
  };
}
