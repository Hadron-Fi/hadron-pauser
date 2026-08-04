export interface SlackAlerterOptions {
  /** Slack incoming-webhook URL. When set (and no bot token), used for delivery. */
  webhookUrl?: string;
  /**
   * Slack bot token (`xoxb-…`). When set together with `channel`, delivery uses
   * `chat.postMessage` instead of the webhook — which returns the posted message's
   * `ts` (so callers can thread replies) and accepts `thread_ts`. Falls back to the
   * webhook when unset. A bot token needs the `chat:write` scope.
   */
  botToken?: string;
  /** Channel id (e.g. `C0123…`) or name (`#alerts`) — required for bot-token delivery. */
  channel?: string;
  service: string;
  cluster?: string;
  /**
   * Minimum interval between alerts that share a `key` (default the message
   * text). Prevents a flapping failure from spamming the channel. Default
   * 60_000. Set 0 to disable rate-limiting.
   */
  minIntervalMs?: number;
  /** POST timeout. Default 8_000. */
  timeoutMs?: number;
}

/**
 * A Slack Block Kit block (https://api.slack.com/block-kit). Typed loosely so the
 * package keeps zero dependencies — callers assemble the JSON themselves.
 */
export type SlackBlock = Record<string, unknown>;

export interface SlackAlertOptions {
  key?: string;
  force?: boolean;
  blocks?: SlackBlock[];
  color?: string;
  /**
   * Post this message as a reply in the thread of an earlier message (its `ts`).
   * Only honoured in bot-token mode; ignored for webhook delivery.
   */
  threadTs?: string;
}

export interface SlackAlerter {
  /**
   * Post a message to Slack, prefixed with `[service/cluster]`. Deduped per
   * `key` within `minIntervalMs` unless `force` is set. Never throws — Slack
   * failures are logged to stderr so alerting can't take the service down.
   *
   * Without `blocks`, `message` is sent as the top-level `text`. When `blocks`
   * is supplied, it's wrapped in a single attachment so Slack renders a colored
   * left bar (`color`, e.g. `#E01E5A`) — the bar only shows on attachments, not
   * top-level blocks — and `message` rides as that attachment's `fallback`
   * (notification/preview text only). It is NOT sent as a top-level `text`, which
   * Slack would render as a duplicate raw line above the card.
   *
   * Returns the posted message's `ts` in bot-token mode (so the caller can thread
   * replies off it); returns `undefined` for webhook delivery, when deduped, or on
   * failure.
   */
  alert(message: string, opts?: SlackAlertOptions): Promise<string | undefined>;
  /** True when bot-token delivery is configured (threading + message `ts` available). */
  readonly canThread: boolean;
}

export function createSlackAlerter(options: SlackAlerterOptions): SlackAlerter {
  const minIntervalMs = options.minIntervalMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const prefix = options.cluster
    ? `[${options.service}/${options.cluster}]`
    : `[${options.service}]`;
  const lastSentAt = new Map<string, number>();
  const useBot = Boolean(options.botToken && options.channel);

  async function postViaBot(text: string, opts?: SlackAlertOptions): Promise<string | undefined> {
    // With blocks: render only the attachment (colored bar) and use `text` as the
    // attachment fallback (notification/preview) — NOT a top-level message, which Slack
    // would render as a duplicate raw line above the card. Without blocks: plain text.
    const body: Record<string, unknown> =
      opts?.blocks && opts.blocks.length > 0
        ? { channel: options.channel, attachments: [{ color: opts.color, blocks: opts.blocks, fallback: text }] }
        : { channel: options.channel, text };
    if (opts?.threadTs) body.thread_ts = opts.threadTs;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${options.botToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; ts?: string; error?: string } | null;
    if (!res.ok || !json?.ok) {
      console.error(
        `[observability] Slack chat.postMessage failed (${res.status}): ${json?.error ?? "unknown"}`,
      );
      return undefined;
    }
    return json.ts;
  }

  async function postViaWebhook(text: string, opts?: SlackAlertOptions): Promise<void> {
    // See postViaBot: with blocks, `text` rides as the attachment fallback (notification
    // only) so the card isn't shadowed by a duplicate top-level message line.
    const body =
      opts?.blocks && opts.blocks.length > 0
        ? { attachments: [{ color: opts.color, blocks: opts.blocks, fallback: text }] }
        : { text };
    const res = await fetch(options.webhookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(
        `[observability] Slack webhook failed (${res.status}): ${errBody.slice(0, 200)}`,
      );
    }
  }

  return {
    canThread: useBot,

    async alert(message, opts) {
      if (!useBot && !options.webhookUrl) return undefined;

      const key = opts?.key ?? message;
      const now = Date.now();
      if (!opts?.force && minIntervalMs > 0) {
        const last = lastSentAt.get(key);
        if (last !== undefined && now - last < minIntervalMs) return undefined;
      }
      lastSentAt.set(key, now);

      const text = `${prefix} ${message}`;
      try {
        if (useBot) return await postViaBot(text, opts);
        await postViaWebhook(text, opts);
        return undefined;
      } catch (err) {
        console.error(
          `[observability] Slack alert error:`,
          err instanceof Error ? err.message : String(err),
        );
        return undefined;
      }
    },
  };
}
