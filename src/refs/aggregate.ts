import { median } from "../util.js";
import { RefSource, RefSourceStatus, statusOf } from "./types.js";

/**
 * Robust aggregation across ref sources. Discipline (see DESIGN.md §7):
 * price detectors may only PAUSE on an "ok" reference — below quorum or above
 * max dispersion the reference is degraded and detectors downgrade to
 * alert-only. Fail-degraded, never fail-pause.
 */

export interface RefAggregate {
  /** robust mid across fresh sources; null when below quorum */
  mid: number | null;
  quality: "ok" | "degraded";
  reason: string | null;
  dispersionBps: number | null;
  freshCount: number;
  sources: RefSourceStatus[];
}

export function aggregateRefs(
  sources: RefSource[],
  now: number,
  quorum: number,
  maxDispersionBps: number,
): RefAggregate {
  const statuses = sources.map((s) => statusOf(s, now));
  const fresh = statuses.filter((s) => s.fresh) as Array<RefSourceStatus & { price: number }>;

  if (fresh.length === 0) {
    return { mid: null, quality: "degraded", reason: "no_fresh_sources", dispersionBps: null, freshCount: 0, sources: statuses };
  }

  const prices = fresh.map((s) => s.price);
  const mid = median(prices);
  const dispersionBps =
    prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / mid) * 1e4 : 0;

  if (fresh.length < quorum) {
    return { mid, quality: "degraded", reason: `below_quorum(${fresh.length}/${quorum})`, dispersionBps, freshCount: fresh.length, sources: statuses };
  }
  if (dispersionBps > maxDispersionBps) {
    return { mid, quality: "degraded", reason: `dispersion(${dispersionBps.toFixed(1)}bps>${maxDispersionBps})`, dispersionBps, freshCount: fresh.length, sources: statuses };
  }
  return { mid, quality: "ok", reason: null, dispersionBps, freshCount: fresh.length, sources: statuses };
}
