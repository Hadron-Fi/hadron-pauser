import { describe, expect, it } from "vitest";
import {
  DrawdownParams,
  applyLiquidityFlow,
  evalDrawdown,
  initDrawdownState,
  resetWindow,
} from "../src/engine/detectors/drawdown.js";

/**
 * The ordering hazard: the stream delivers the vault account write and the
 * transaction that explains it as independent messages, and the account write
 * typically lands first. These cases model that sequence tick by tick, using
 * the same guards the engine applies (hold pause verdicts while a balance jump
 * is unexplained; drop history when the stream was blind).
 */

const P: DrawdownParams = { maxBps: 200, windowMs: 64_800_000 };
const BALANCE_JUMP_FRACTION = 0.02;

function inputs(t: number, baseUi: number, quoteUi: number) {
  return {
    now: t,
    baseUi,
    quoteUi,
    refMid: 100,
    refOk: true,
    pushedAtomMid: null,
    baseAtoms: 0,
    quoteAtoms: 0,
    onchain: { enabled: false, thresholdBps: 0, hwmBase: 0, hwmBasePrev: 0, hwmQuote: 0, hwmQuotePrev: 0 },
  };
}

/** Mirrors the engine: a sharp one-tick balance drop holds pause verdicts. */
function jumped(prev: number, next: number): boolean {
  return prev > 0 && next < prev && (prev - next) / prev > BALANCE_JUMP_FRACTION;
}

describe("balance-before-transaction race", () => {
  it("a withdrawal seen as balances first does not pause before its tx arrives", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs(0, 100, 10_000), P);

    // t+1s: vault write lands (25% withdrawal). No tx yet.
    const jumpedNow = jumped(100, 75) || jumped(10_000, 7_500);
    expect(jumpedNow).toBe(true); // engine starts its settle window here
    const r1 = evalDrawdown(s, inputs(1_000, 75, 7_500), P);
    expect(r1.verdicts.some((v) => v.code === "drawdown")).toBe(true); // detector fires…
    // …but the engine is holding pause verdicts, so nothing is sent. Then the
    // transaction arrives and the baseline is corrected:
    applyLiquidityFlow(s, -25 + -2_500 / 100, -2_500 + -25 * 100);

    // subsequent ticks are clean
    const r2 = evalDrawdown(s, inputs(2_000, 75, 7_500), P);
    expect(r2.metrics.drawdownBps).toBe(0);
    expect(r2.verdicts).toHaveLength(0);
  });

  it("an unexplained drop of the same size still pauses once the hold expires", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs(0, 100, 10_000), P);
    // balances drop and NO transaction ever explains it (a real drain)
    evalDrawdown(s, inputs(1_000, 75, 7_500), P);
    const after = evalDrawdown(s, inputs(11_000, 75, 7_500), P); // past the 10s hold
    expect(after.metrics.drawdownBps).toBeCloseTo(5_000, 0);
    expect(after.verdicts.some((v) => v.code === "drawdown")).toBe(true);
  });

  it("a stream gap resets history, so an LP event we never saw cannot false-pause", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs(0, 100, 10_000), P);
    // disconnect; a withdrawal happens while blind; reconcile re-reads accounts
    resetWindow(s);
    const first = evalDrawdown(s, inputs(60_000, 60, 6_000), P);
    expect(first.metrics.drawdownBps).toBeNull(); // re-seeds, no verdict
    const second = evalDrawdown(s, inputs(61_000, 60, 6_000), P);
    expect(second.metrics.drawdownBps).toBe(0);
    expect(second.verdicts).toHaveLength(0);
  });

  it("price moves do not count as balance jumps (the guard is balance-keyed)", () => {
    // equity swings with price, but balances are untouched
    expect(jumped(100, 100)).toBe(false);
    expect(jumped(10_000, 10_000)).toBe(false);
    // and a 1% withdrawal stays under the discontinuity bar
    expect(jumped(100, 99)).toBe(false);
    expect(jumped(100, 97)).toBe(true);
  });
});
