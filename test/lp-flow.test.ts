import { describe, expect, it } from "vitest";
import {
  DrawdownInputs,
  DrawdownParams,
  applyLiquidityFlow,
  evalDrawdown,
  initDrawdownState,
  resetWindow,
} from "../src/engine/detectors/drawdown.js";

const P: DrawdownParams = { maxBps: 200, windowMs: 64_800_000 };

function inputs(over: Partial<DrawdownInputs>): DrawdownInputs {
  return {
    now: 0,
    baseUi: 100,
    quoteUi: 10_000,
    refMid: 100, // balanced: eBase 200, eQuote 20_000
    refOk: true,
    pushedAtomMid: null,
    baseAtoms: 0,
    quoteAtoms: 0,
    onchain: { enabled: false, thresholdBps: 0, hwmBase: 0, hwmBasePrev: 0, hwmQuote: 0, hwmQuotePrev: 0 },
    ...over,
  };
}

/** Equity deltas for a flow of dx base / dy quote at `mid`. */
function deltas(dx: number, dy: number, mid: number) {
  return { dBase: dx + dy / mid, dQuote: dy + dx * mid };
}

describe("liquidity flow (deposits and withdrawals)", () => {
  it("a 25% withdrawal does NOT register as drawdown once accounted", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P); // seed at 100 base / 10_000 quote
    // operator withdraws 25 base + 2_500 quote (25% of each side)
    const d = deltas(-25, -2_500, 100);
    applyLiquidityFlow(s, d.dBase, d.dQuote);
    const r = evalDrawdown(s, inputs({ now: 60_000, baseUi: 75, quoteUi: 7_500 }), P);
    expect(r.metrics.drawdownBps).toBe(0);
    expect(r.verdicts).toHaveLength(0);
  });

  it("without accounting, that same withdrawal would have paused the pool", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    const r = evalDrawdown(s, inputs({ now: 60_000, baseUi: 75, quoteUi: 7_500 }), P);
    expect(r.metrics.drawdownBps).toBeCloseTo(5_000, 0); // 25% per denom -> 5000bps
    expect(r.verdicts.some((v) => v.code === "drawdown")).toBe(true);
  });

  it("a deposit raises the baseline, so a later real loss is still measured correctly", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    const d = deltas(100, 10_000, 100); // double the pool
    applyLiquidityFlow(s, d.dBase, d.dQuote);
    // no loss yet at the doubled size
    const flat = evalDrawdown(s, inputs({ now: 60_000, baseUi: 200, quoteUi: 20_000 }), P);
    expect(flat.metrics.drawdownBps).toBe(0);
    // now a genuine 1% loss on the quote side at the new size
    const lossy = evalDrawdown(s, inputs({ now: 120_000, baseUi: 200, quoteUi: 19_600 }), P);
    expect(lossy.metrics.drawdownBps).toBeCloseTo(200, 0); // 100bps per denom
    expect(lossy.verdicts.some((v) => v.code === "drawdown")).toBe(true);
  });

  it("deposit then equal withdrawal nets to zero", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    const dep = deltas(50, 5_000, 100);
    applyLiquidityFlow(s, dep.dBase, dep.dQuote);
    const wd = deltas(-50, -5_000, 100);
    applyLiquidityFlow(s, wd.dBase, wd.dQuote);
    const r = evalDrawdown(s, inputs({ now: 60_000 }), P);
    expect(r.metrics.drawdownBps).toBe(0);
    expect(r.verdicts).toHaveLength(0);
  });

  it("a trading drain of the same size as a withdrawal still trips (flow is not a free pass)", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    // account a small withdrawal...
    const d = deltas(-5, -500, 100);
    applyLiquidityFlow(s, d.dBase, d.dQuote);
    // ...but the pool actually lost far more than that (drained at bad prices)
    const r = evalDrawdown(s, inputs({ now: 60_000, baseUi: 75, quoteUi: 7_500 }), P);
    expect(r.metrics.drawdownBps).toBeGreaterThan(200);
    expect(r.verdicts.some((v) => v.code === "drawdown")).toBe(true);
  });

  it("resetWindow drops history (the fallback when the flow cannot be valued)", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    resetWindow(s);
    expect(s.window).toHaveLength(0);
    // first observation after a reset just re-seeds: no verdict even if smaller
    const r = evalDrawdown(s, inputs({ now: 60_000, baseUi: 10, quoteUi: 1_000 }), P);
    expect(r.metrics.drawdownBps).toBeNull();
    expect(r.verdicts).toHaveLength(0);
  });
});
