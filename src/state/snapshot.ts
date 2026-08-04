import { ConfigSnapshot } from "../chain/accounts.js";
import { FieldChange } from "../engine/detectors/authority-change.js";

/**
 * Restart memory. The service is stateless-with-reconcile for everything that
 * can be re-derived from chain; exactly two things cannot be, and they are
 * what the snapshot carries:
 *
 *  1. The drawdown equity window (reference-marked peaks). Without it, every
 *     restart — including every deploy — re-arms the budget from zero over
 *     `windowMs`. Stored DOWNSAMPLED to per-minute maxima: the budget only
 *     ever compares against the window max, and max-of-bucket-maxima equals
 *     the true max, so this is lossless where it matters (~1080 entries for
 *     18h instead of ~64k).
 *  2. The authority/config baseline. Without it, a rotation or a
 *     delta_staleness change that lands WHILE THE PROCESS IS DOWN is silently
 *     adopted as the boot baseline. With it, boot diffs stored-vs-chain and
 *     the change classifies exactly like a live one (pause-tier included).
 *
 * The snapshot is an INPUT to a safety system: whoever can write the store
 * can suppress drawdown detection (fake low peaks). Scope the store to the
 * task role / host user; a missing or corrupt snapshot degrades to a fresh
 * start, never a crash.
 */

export const SNAPSHOT_VERSION = 1;

export interface EquitySampleJson {
  ts: number;
  eBase: number;
  eQuote: number;
}

export interface PoolSnapshot {
  window?: EquitySampleJson[];
  /** stringified watched Config fields + oracleAuthority (baselineFields) */
  fields?: Record<string, string>;
  pausedByUsSig?: string;
}

export interface PauserSnapshot {
  version: number;
  savedAt: number;
  pools: Record<string, PoolSnapshot>;
}

/** Config fields whose changes are classified (shared with the engine's live
 *  diff so downtime diffs behave identically). HWM/rotation fields churn on
 *  every guard evaluation and are deliberately excluded. */
export const WATCHED_CONFIG_FIELDS: Array<keyof ConfigSnapshot> = [
  "state",
  "authority",
  "pendingAuthority",
  "deltaStaleness",
  "depositAuthority",
  "withdrawAuthority",
  "pauseAuthority",
  "thresholdBps",
  "rotationIntervalSlots",
];

export function baselineFields(
  config: ConfigSnapshot,
  oracleAuthority: string,
): Record<string, string> {
  const out: Record<string, string> = { oracleAuthority };
  for (const f of WATCHED_CONFIG_FIELDS) out[f] = String(config[f]);
  return out;
}

export function diffBaseline(
  stored: Record<string, string>,
  current: Record<string, string>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, newValue] of Object.entries(current)) {
    const oldValue = stored[field];
    if (oldValue !== undefined && oldValue !== newValue) {
      changes.push({ field, oldValue, newValue, slot: 0 });
    }
  }
  return changes;
}

/** Per-bucket per-denomination maxima; preserves window-max exactly. */
export function downsampleWindow(
  window: EquitySampleJson[],
  bucketMs = 60_000,
): EquitySampleJson[] {
  const buckets = new Map<number, EquitySampleJson>();
  for (const s of window) {
    const b = Math.floor(s.ts / bucketMs);
    const cur = buckets.get(b);
    if (!cur) {
      buckets.set(b, { ...s });
    } else {
      if (s.eBase > cur.eBase) cur.eBase = s.eBase;
      if (s.eQuote > cur.eQuote) cur.eQuote = s.eQuote;
      if (s.ts > cur.ts) cur.ts = s.ts;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export function isValidSnapshot(x: unknown): x is PauserSnapshot {
  const s = x as PauserSnapshot;
  return (
    s != null &&
    typeof s === "object" &&
    s.version === SNAPSHOT_VERSION &&
    typeof s.savedAt === "number" &&
    s.pools != null &&
    typeof s.pools === "object"
  );
}
