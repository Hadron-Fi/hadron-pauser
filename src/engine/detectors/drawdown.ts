import { lossBps } from "../../util.js";
import { Verdict } from "../types.js";

/**
 * The drawdown budget: the pool may never lose more than `maxBps`
 * (dual-denomination sum of losses, marked at the INDEPENDENT reference
 * price) within `windowMs`, or it pauses.
 *
 * This replaced the earlier chain-mirrored HWM machinery (2026-08-04
 * simplification): a rolling window-max baseline has the same detection
 * power as high-water marks with rotation, minus the rotation semantics —
 * and no rotation means no rotation forgiveness, so the budget is a hard
 * ceiling on extraction per window. Burst drains are covered too (the window
 * max includes a moment ago), and sub-budget bursts are the mid-deviation
 * detector's job (off-market quotes show there in seconds).
 *
 * Accounting facts (drive threshold sizing — see llms.txt §4):
 *  - a real drain registers in BOTH denominations → ~2× the stolen value;
 *  - a pure price move registers once → ~half the move on a balanced book,
 *    so this is an MTM stop-loss: a large benign market move can consume
 *    budget (the on-chain guard shares this semantics deliberately).
 *
 * Fixed behaviors (deliberately not knobs): pre-alert at 60% of the budget,
 * critical at 90%; alert when the ON-CHAIN guard (its own pushed-mid marks)
 * is 60% consumed, critical at 90%.
 *
 * Pure module: no clocks, no I/O. The engine owns state and time.
 */

const NEARING_PCT = 60;
const CRITICAL_PCT = 90;

export interface DrawdownParams {
  maxBps: number;
  windowMs: number;
}

interface EquitySample {
  ts: number;
  eBase: number;
  eQuote: number;
}

export interface DrawdownState {
  window: EquitySample[];
}

export function initDrawdownState(): DrawdownState {
  return { window: [] };
}

/**
 * Neutralize a liquidity event (deposit or withdrawal).
 *
 * The budget measures value the pool LOSES, and a deposit or withdrawal moves
 * equity without anyone losing anything — so a legitimate withdrawal would
 * otherwise read exactly like a drain and pause the pool. The chain has the
 * same problem and solves it by re-anchoring both HWM windows to the
 * post-event value (`lp_drawdown_reanchor`).
 *
 * We do the equivalent but keep history: shift every stored sample by the
 * equity delta the flow caused, so the baseline moves with the pool and
 * trading losses on either side of the event still accumulate normally.
 * `dBase`/`dQuote` are signed equity deltas in each denomination (positive for
 * a deposit).
 *
 * Callers that cannot value the flow (no trustworthy reference at that
 * moment) should `resetWindow` instead — losing history is safe, false
 * pauses are not.
 */
export function applyLiquidityFlow(state: DrawdownState, dBase: number, dQuote: number): void {
  for (const s of state.window) {
    s.eBase += dBase;
    s.eQuote += dQuote;
  }
}

/** Drop history entirely: the next observation becomes the new baseline. */
export function resetWindow(state: DrawdownState): void {
  state.window = [];
}

export interface DrawdownInputs {
  now: number;
  /** vault balances in UI units */
  baseUi: number;
  quoteUi: number;
  /** aggregated reference mid (UI quote-per-base); null/degraded => skip */
  refMid: number | null;
  refOk: boolean;
  /** pushed oracle mid as ATOM ratio + vault ATOM balances, for on-chain headroom */
  pushedAtomMid: number | null;
  baseAtoms: number;
  quoteAtoms: number;
  onchain: {
    enabled: boolean;
    thresholdBps: number;
    /** Q32.32 atom-value HWMs, already divided by 2^32 */
    hwmBase: number;
    hwmBasePrev: number;
    hwmQuote: number;
    hwmQuotePrev: number;
  };
}

export interface DrawdownEvalResult {
  verdicts: Verdict[];
  metrics: {
    /** dual-denom loss vs the window max, at reference marks */
    drawdownBps: number | null;
    /** drawdownBps as % of the budget */
    drawdownPct: number | null;
    onchainSumBps: number | null;
    headroomPct: number | null;
  };
}

/** Dual-denom sum of losses given current equities and baseline refs. */
export function dualDenomSumBps(
  eBase: number,
  eQuote: number,
  refBase: number,
  refQuote: number,
): number {
  return lossBps(eBase, refBase) + lossBps(eQuote, refQuote);
}

export function evalDrawdown(
  state: DrawdownState,
  inputs: DrawdownInputs,
  p: DrawdownParams,
): DrawdownEvalResult {
  const metrics: DrawdownEvalResult["metrics"] = {
    drawdownBps: null,
    drawdownPct: null,
    onchainSumBps: null,
    headroomPct: null,
  };
  const verdicts: Verdict[] = [];

  // --- on-chain guard headroom (pushed-mid marks; the real guard's view) ---
  if (inputs.onchain.enabled && inputs.pushedAtomMid != null && inputs.pushedAtomMid > 0) {
    const vBase = inputs.baseAtoms + inputs.quoteAtoms / inputs.pushedAtomMid;
    const vQuote = inputs.quoteAtoms + inputs.baseAtoms * inputs.pushedAtomMid;
    const refB = Math.max(inputs.onchain.hwmBase, inputs.onchain.hwmBasePrev);
    const refQ = Math.max(inputs.onchain.hwmQuote, inputs.onchain.hwmQuotePrev);
    const sum = dualDenomSumBps(vBase, vQuote, refB, refQ);
    metrics.onchainSumBps = sum;
    if (inputs.onchain.thresholdBps > 0) {
      const pct = (sum / inputs.onchain.thresholdBps) * 100;
      metrics.headroomPct = pct;
      if (pct >= NEARING_PCT) {
        verdicts.push({
          detector: "drawdown",
          code: "guard-headroom",
          level: "alert",
          severity: pct >= CRITICAL_PCT ? "critical" : "high",
          message: `on-chain drawdown guard ${pct.toFixed(0)}% consumed (${sum.toFixed(1)}/${inputs.onchain.thresholdBps}bps, pushed-mid marks)`,
          evidence: { onchainSumBps: sum, thresholdBps: inputs.onchain.thresholdBps },
        });
      }
    }
  }

  // --- the budget, at reference marks --------------------------------------
  if (inputs.refMid == null || !inputs.refOk || !(inputs.refMid > 0)) {
    // Degraded reference: no marks, no samples, no verdicts. The window
    // stretches across the blind gap, so a drain during it is caught against
    // the pre-gap max once the reference recovers.
    return { verdicts, metrics };
  }

  const eBase = inputs.baseUi + inputs.quoteUi / inputs.refMid;
  const eQuote = inputs.quoteUi + inputs.baseUi * inputs.refMid;

  while (state.window.length > 0 && inputs.now - state.window[0].ts > p.windowMs) {
    state.window.shift();
  }
  if (state.window.length > 0) {
    // Single-pass max — the window can hold tens of thousands of one-second
    // samples, so no spread-based Math.max.
    let maxBase = -Infinity;
    let maxQuote = -Infinity;
    for (const s of state.window) {
      if (s.eBase > maxBase) maxBase = s.eBase;
      if (s.eQuote > maxQuote) maxQuote = s.eQuote;
    }
    const dd = dualDenomSumBps(eBase, eQuote, maxBase, maxQuote);
    const pct = (dd / p.maxBps) * 100;
    metrics.drawdownBps = dd;
    metrics.drawdownPct = pct;
    if (dd >= p.maxBps) {
      verdicts.push({
        detector: "drawdown",
        code: "drawdown",
        level: "pause",
        severity: "critical",
        message: `pool equity down ${dd.toFixed(1)}bps at reference marks within ${Math.round(p.windowMs / 3_600_000)}h (budget ${p.maxBps}bps)`,
        evidence: { drawdownBps: dd, budgetBps: p.maxBps, windowMs: p.windowMs, eBase, eQuote, refMid: inputs.refMid },
      });
    } else if (pct >= NEARING_PCT) {
      verdicts.push({
        detector: "drawdown",
        code: "drawdown-nearing",
        level: "alert",
        severity: pct >= CRITICAL_PCT ? "critical" : "high",
        message: `drawdown at ${pct.toFixed(0)}% of budget (${dd.toFixed(1)}/${p.maxBps}bps at reference marks)`,
        evidence: { drawdownBps: dd, budgetBps: p.maxBps, eBase, eQuote, refMid: inputs.refMid },
      });
    }
  }
  state.window.push({ ts: inputs.now, eBase, eQuote });

  return { verdicts, metrics };
}
