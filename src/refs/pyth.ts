import { RefSample, RefSource } from "./types.js";

/**
 * Pyth via Hermes HTTP polling (v2/updates/price/latest). Deliberately the
 * boring transport: no SSE reconnect state, easy to reason about staleness.
 * `ts` is Pyth's publish_time so a stalled feed reads as stale here even if
 * the HTTP poll keeps succeeding.
 */
export class PythRef implements RefSource {
  readonly name: string;
  readonly staleMs: number;
  private sample: RefSample | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly feedId: string,
    private readonly baseUrl: string,
    private readonly pollMs: number,
    private readonly invert: boolean,
    staleMs: number,
    private readonly onError: (err: unknown) => void,
  ) {
    this.name = `pyth:${feedId.slice(0, 10)}`;
    this.staleMs = staleMs;
  }

  start(): void {
    const poll = async () => {
      try {
        const url = `${this.baseUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(this.feedId)}&parsed=true`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`hermes ${res.status}`);
        const body = (await res.json()) as {
          parsed?: Array<{ price: { price: string; expo: number; publish_time: number } }>;
        };
        const p = body.parsed?.[0]?.price;
        if (p) {
          const price = Number(p.price) * 10 ** p.expo;
          if (price > 0) {
            this.sample = { price: this.invert ? 1 / price : price, ts: p.publish_time * 1000 };
          }
        }
      } catch (err) {
        this.onError(err);
      }
    };
    void poll();
    this.timer = setInterval(poll, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): RefSample | null {
    return this.sample;
  }
}
