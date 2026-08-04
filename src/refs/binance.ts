import WebSocket from "ws";
import { RefSample, RefSource } from "./types.js";

/**
 * Binance bookTicker mid = (bestBid + bestAsk) / 2.
 * Note: binance.com is geo-blocked (HTTP 451) from US IPs — run in eu-central-1
 * (the hadron-cli precedent) or configure a different wsBase / source.
 */
export class BinanceRef implements RefSource {
  readonly name: string;
  readonly staleMs: number;
  private ws: WebSocket | null = null;
  private sample: RefSample | null = null;
  private stopped = false;
  private reconnectDelayMs = 1_000;

  constructor(
    private readonly symbol: string,
    private readonly wsBase: string,
    private readonly invert: boolean,
    staleMs: number,
    private readonly onError: (err: unknown) => void,
  ) {
    this.name = `binance:${symbol}`;
    this.staleMs = staleMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.wsBase}/${this.symbol.toLowerCase()}@bookTicker`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const bid = Number(msg.b);
        const ask = Number(msg.a);
        if (bid > 0 && ask > 0) {
          const mid = (bid + ask) / 2;
          this.sample = { price: this.invert ? 1 / mid : mid, ts: Date.now() };
          this.reconnectDelayMs = 1_000;
        }
      } catch (err) {
        this.onError(err);
      }
    });
    const scheduleReconnect = () => {
      if (this.stopped) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      setTimeout(() => this.connect(), delay).unref?.();
    };
    ws.on("error", (err) => {
      this.onError(err);
      ws.close();
    });
    ws.on("close", scheduleReconnect);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  latest(): RefSample | null {
    return this.sample;
  }
}
