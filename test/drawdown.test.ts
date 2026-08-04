import { describe, expect, it } from "vitest";
import {
  DrawdownInputs,
  DrawdownParams,
  evalDrawdown,
  initDrawdownState,
} from "../src/engine/detectors/drawdown.js";

const P: DrawdownParams = { maxBps: 200, windowMs: 64_800_000 };

function inputs(over: Partial<DrawdownInputs>): DrawdownInputs {
  return {
    now: 0,
    baseUi: 100,
    quoteUi: 10_000,
    refMid: 100, // balanced book: 100 base * 100 = 10_000 quote; eQuote 20_000, eBase 200
    refOk: true,
    pushedAtomMid: null,
    baseAtoms: 0,
    quoteAtoms: 0,
    onchain: { enabled: false, thresholdBps: 0, hwmBase: 0, hwmBasePrev: 0, hwmQuote: 0, hwmQuotePrev: 0 },
    ...over,
  };
}

describe("drawdown budget", () => {
  it("first observation just seeds the window, no verdicts", () => {
    const s = initDrawdownState();
    const r = evalDrawdown(s, inputs({}), P);
    expect(r.verdicts).toHaveLength(0);
    expect(r.metrics.drawdownBps).toBeNull();
    expect(s.window).toHaveLength(1);
  });

  it("a real drain counts in BOTH denominations (~2x stolen value) and trips the budget", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    // attacker bought 20 base for only 1_000 quote (fair 2_000): 500bp loss per denom -> 1000bp sum
    const r = evalDrawdown(s, inputs({ now: 60_000, baseUi: 80, quoteUi: 11_000 }), P);
    expect(r.metrics.drawdownBps).toBeGreaterThan(900);
    expect(r.verdicts.some((v) => v.code === "drawdown")).toBe(true);
  });

  it("a pure price move on a balanced book registers ~half the move (MTM stop-loss semantics)", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    // ref +10%: base-denom equity falls ~455bp, quote side gains (clamped 0)
    const r = evalDrawdown(s, inputs({ now: 60_000, refMid: 110 }), P);
    expect(r.metrics.drawdownBps).toBeGreaterThan(400);
    expect(r.metrics.drawdownBps).toBeLessThan(500);
    expect(r.verdicts.some((v) => v.code === "drawdown")).toBe(true); // > 200bp budget
  });

  it("gains never consume budget", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    const r = evalDrawdown(s, inputs({ now: 60_000, quoteUi: 10_500 }), P);
    expect(r.metrics.drawdownBps).toBe(0);
    expect(r.verdicts).toHaveLength(0);
  });

  it("budget boundary is inclusive: exactly at maxBps pauses, just below pre-alerts", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    // 100bp real loss -> 200bp sum == budget
    const at = evalDrawdown(s, inputs({ now: 60_000, quoteUi: 9_800 }), P);
    expect(at.metrics.drawdownBps).toBeCloseTo(200, 5);
    expect(at.verdicts.some((v) => v.code === "drawdown")).toBe(true);
    // fresh state: 90bp loss -> 180bp = 90% -> critical nearing, no pause
    const s2 = initDrawdownState();
    evalDrawdown(s2, inputs({}), P);
    const below = evalDrawdown(s2, inputs({ now: 60_000, quoteUi: 9_820 }), P);
    expect(below.verdicts.some((v) => v.code === "drawdown")).toBe(false);
    const nearing = below.verdicts.find((v) => v.code === "drawdown-nearing");
    expect(nearing?.severity).toBe("critical"); // 180/200 = 90%
  });

  it("nearing pre-alert: high at >=60%, absent below", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    // 130-unit quote drop on 20_000 equity -> 65bp per denom -> 130bp = 65% of 200
    const high = evalDrawdown(s, inputs({ now: 60_000, quoteUi: 9_870 }), P);
    const v = high.verdicts.find((x) => x.code === "drawdown-nearing");
    expect(v?.level).toBe("alert");
    expect(v?.severity).toBe("high");
    // 80-unit drop -> 80bp sum = 40% -> nothing
    const s2 = initDrawdownState();
    evalDrawdown(s2, inputs({}), P);
    const quiet = evalDrawdown(s2, inputs({ now: 60_000, quoteUi: 9_920 }), P);
    expect(quiet.verdicts).toHaveLength(0);
  });

  it("the window forgets peaks beyond its horizon (the budget is per-window, honestly)", () => {
    const s = initDrawdownState();
    const p = { ...P, windowMs: 100_000 };
    evalDrawdown(s, inputs({}), p); // 20_000 peak at t=0
    evalDrawdown(s, inputs({ now: 50_000, quoteUi: 9_900 }), p); // -100bp
    evalDrawdown(s, inputs({ now: 200_000, quoteUi: 9_900 }), p); // flat re-observation
    // at t=250s only the t=200s sample (equity 19_900) is in-window: further drop
    // to 9_850 measures ~50bp vs it, not 150bp+ vs the aged-out peak
    const r = evalDrawdown(s, inputs({ now: 250_000, quoteUi: 9_850 }), p);
    expect(r.metrics.drawdownBps).not.toBeNull();
    expect(r.metrics.drawdownBps!).toBeLessThan(120);
    expect(r.verdicts.some((v) => v.code === "drawdown")).toBe(false);
  });

  it("degraded reference: no marks, no samples, no verdicts", () => {
    const s = initDrawdownState();
    evalDrawdown(s, inputs({}), P);
    const r = evalDrawdown(s, inputs({ now: 60_000, refOk: false, quoteUi: 5_000 }), P);
    expect(r.verdicts).toHaveLength(0);
    expect(r.metrics.drawdownBps).toBeNull();
    expect(s.window).toHaveLength(1); // degraded tick appended nothing
  });

  it("on-chain guard headroom alert fires from pushed-mid marks even when ref is degraded", () => {
    const s = initDrawdownState();
    const r = evalDrawdown(
      s,
      inputs({
        refOk: false,
        refMid: null,
        pushedAtomMid: 1,
        baseAtoms: 90,
        quoteAtoms: 100,
        onchain: {
          enabled: true,
          thresholdBps: 150,
          hwmBase: 200,
          hwmBasePrev: 0,
          hwmQuote: 200,
          hwmQuotePrev: 0,
        },
      }),
      P,
    );
    const headroom = r.verdicts.find((v) => v.code === "guard-headroom");
    expect(headroom).toBeDefined();
    expect(headroom!.severity).toBe("critical"); // 1000bp/150bp >> 90%
  });
});
