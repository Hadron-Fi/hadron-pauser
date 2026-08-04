import { describe, expect, it } from "vitest";
import { evalMidDeviation } from "../src/engine/detectors/mid-deviation.js";

const P = { maxBps: 60 };

describe("mid deviation", () => {
  it("quiet market: metric computed, no verdicts", () => {
    const r = evalMidDeviation({ pushedUi: 100.1, refMid: 100, refOk: true }, P);
    expect(r.metrics.midDeviationBps).toBeCloseTo(10, 0);
    expect(r.verdicts).toHaveLength(0);
  });

  it("nearing alert at >=60% of the limit", () => {
    const r = evalMidDeviation({ pushedUi: 100.4, refMid: 100, refOk: true }, P); // 40bps = 67%
    const v = r.verdicts.find((x) => x.code === "mid-deviation-nearing");
    expect(v?.level).toBe("alert");
    expect(v?.severity).toBe("high");
  });

  it("pause verdict above the limit, critical severity, nearing suppressed", () => {
    const r = evalMidDeviation({ pushedUi: 100.7, refMid: 100, refOk: true }, P); // 70bps
    const v = r.verdicts.find((x) => x.code === "mid-deviation");
    expect(v?.level).toBe("pause");
    expect(v?.severity).toBe("critical");
    expect(r.verdicts.some((x) => x.code === "mid-deviation-nearing")).toBe(false);
  });

  it("deviation is symmetric (a too-cheap mid fires too)", () => {
    const r = evalMidDeviation({ pushedUi: 99.3, refMid: 100, refOk: true }, P); // -70bps
    expect(r.verdicts.some((x) => x.code === "mid-deviation")).toBe(true);
  });

  it("degraded reference: metric still reported, verdicts suppressed", () => {
    const r = evalMidDeviation({ pushedUi: 150, refMid: 100, refOk: false }, P); // wildly off
    expect(r.metrics.midDeviationBps).toBeGreaterThan(1_000);
    expect(r.verdicts).toHaveLength(0);
  });

  it("missing inputs: nothing", () => {
    expect(evalMidDeviation({ pushedUi: null, refMid: 100, refOk: true }, P).verdicts).toHaveLength(0);
    expect(evalMidDeviation({ pushedUi: 100, refMid: null, refOk: true }, P).metrics.midDeviationBps).toBeNull();
  });
});
