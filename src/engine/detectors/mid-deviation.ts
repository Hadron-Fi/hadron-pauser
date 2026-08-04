import { bpsBetween } from "../../util.js";
import { Verdict } from "../types.js";

/**
 * Mid deviation — the primary detector. Compares the pool's PUSHED oracle
 * mid against the aggregated independent reference (the same ref plane the
 * drawdown budget marks with). Any-rate extraction requires quoting
 * off-market, so a compromised quoting authority shows here within seconds
 * of the first bad push — before material value leaves. Also catches a
 * frozen mid while the market moves (deviation grows as the ref walks away).
 *
 * Fixed behavior: pre-alert at 60% of maxBps (not a knob). On a degraded
 * reference the metric is still computed but no verdicts fire — never act
 * on bad data.
 *
 * Pure module: no clocks, no I/O.
 */

const NEARING_PCT = 60;

export interface MidDeviationParams {
  maxBps: number;
}

export interface MidDeviationInputs {
  /** pushed oracle mid, UI quote-per-base (null when the oracle is empty) */
  pushedUi: number | null;
  /** aggregated reference mid, UI quote-per-base */
  refMid: number | null;
  refOk: boolean;
}

export interface MidDeviationResult {
  verdicts: Verdict[];
  metrics: { midDeviationBps: number | null };
}

export function evalMidDeviation(
  inputs: MidDeviationInputs,
  p: MidDeviationParams,
): MidDeviationResult {
  const { pushedUi, refMid, refOk } = inputs;
  const dev =
    pushedUi != null && pushedUi > 0 && refMid != null && refMid > 0
      ? bpsBetween(pushedUi, refMid)
      : null;
  const verdicts: Verdict[] = [];

  if (dev != null && refOk) {
    if (dev >= p.maxBps) {
      verdicts.push({
        detector: "midDeviation",
        code: "mid-deviation",
        level: "pause",
        severity: "critical",
        message: `pushed mid ${dev.toFixed(1)}bps off the independent reference (limit ${p.maxBps}bps)`,
        evidence: { midDeviationBps: dev, pushedUi, refMid },
      });
    } else if (dev >= (p.maxBps * NEARING_PCT) / 100) {
      verdicts.push({
        detector: "midDeviation",
        code: "mid-deviation-nearing",
        level: "alert",
        severity: "high",
        message: `pushed mid ${dev.toFixed(1)}bps off reference (${Math.round((dev / p.maxBps) * 100)}% of the ${p.maxBps}bps limit)`,
        evidence: { midDeviationBps: dev, pushedUi, refMid },
      });
    }
  }

  return { verdicts, metrics: { midDeviationBps: dev } };
}
