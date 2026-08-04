import { atomRatioToUi } from "../util.js";
import { RefSample, RefSource } from "./types.js";

/**
 * A reference price read from a raw on-chain account (u64 LE at a fixed
 * offset, times scale) — e.g. another venue's oracle. Passive: it does not
 * poll; the chain stream router feeds it account bytes (it piggybacks the
 * same gRPC subscription as the pool accounts), and the reconcile sweep
 * refreshes it when the stream is quiet.
 *
 * unit "atomRatio" values are converted to UI with the pool's decimals,
 * injected by the engine when the pool is bootstrapped.
 */
export class OnchainAccountRef implements RefSource {
  readonly name: string;
  readonly staleMs: number;
  private sample: RefSample | null = null;
  private decBase = 0;
  private decQuote = 0;

  constructor(
    readonly account: string,
    private readonly offset: number,
    private readonly scale: number,
    private readonly unit: "ui" | "atomRatio",
    private readonly invert: boolean,
    staleMs: number,
  ) {
    this.name = `onchain:${account.slice(0, 4)}..${account.slice(-4)}`;
    this.staleMs = staleMs;
  }

  setDecimals(decBase: number, decQuote: number): void {
    this.decBase = decBase;
    this.decQuote = decQuote;
  }

  /** Called by the stream router / reconcile with fresh account bytes. */
  update(data: Uint8Array, observedAtMs: number): void {
    if (data.length < this.offset + 8) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rawValue = Number(view.getBigUint64(this.offset, true)) * this.scale;
    if (!(rawValue > 0)) return;
    let price = this.unit === "atomRatio" ? atomRatioToUi(rawValue, this.decBase, this.decQuote) : rawValue;
    if (this.invert) price = 1 / price;
    this.sample = { price, ts: observedAtMs };
  }

  start(): void {}
  stop(): void {}

  latest(): RefSample | null {
    return this.sample;
  }
}
