import { RefSourceConfig } from "../config.js";
import { BinanceRef } from "./binance.js";
import { OnchainAccountRef } from "./onchain-account.js";
import { PythRef } from "./pyth.js";
import { RefSource } from "./types.js";

export * from "./types.js";
export * from "./aggregate.js";
export { OnchainAccountRef } from "./onchain-account.js";

export function buildRefSource(
  cfg: RefSourceConfig,
  onError: (source: string, err: unknown) => void,
): RefSource {
  switch (cfg.kind) {
    case "binance":
      return new BinanceRef(cfg.symbol, cfg.wsBase, cfg.invert, cfg.staleMs, (e) =>
        onError(`binance:${cfg.symbol}`, e),
      );
    case "pyth":
      return new PythRef(cfg.feedId, cfg.url, cfg.pollMs, cfg.invert, cfg.staleMs, (e) =>
        onError(`pyth:${cfg.feedId.slice(0, 10)}`, e),
      );
    case "onchain-account":
      return new OnchainAccountRef(
        cfg.account,
        cfg.offset,
        cfg.scale,
        cfg.unit,
        cfg.invert,
        cfg.staleMs,
      );
  }
}
