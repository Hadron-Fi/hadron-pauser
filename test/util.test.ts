import { describe, expect, it } from "vitest";
import { atomRatioToUi, bpsBetween, expandEnvRef, lossBps, u128LE, uiToAtomRatio } from "../src/util.js";

describe("util", () => {
  it("u128LE round-trips small and large values", () => {
    const buf = new Uint8Array(16);
    buf[0] = 0x39;
    buf[1] = 0x30; // 12345
    expect(u128LE(buf)).toBe(12345n);
    const big = new Uint8Array(16).fill(0xff);
    expect(u128LE(big)).toBe((1n << 128n) - 1n);
    expect(() => u128LE(new Uint8Array(8))).toThrow();
  });

  it("atom ratio <-> ui conversion (SOL/USDC example)", () => {
    // 150 USDC per SOL, decBase 9, decQuote 6 -> atom ratio 150e-3
    expect(uiToAtomRatio(150, 9, 6)).toBeCloseTo(0.15);
    expect(atomRatioToUi(0.15, 9, 6)).toBeCloseTo(150);
  });

  it("lossBps clamps gains to zero", () => {
    expect(lossBps(99, 100)).toBeCloseTo(100);
    expect(lossBps(101, 100)).toBe(0);
    expect(lossBps(100, 0)).toBe(0);
  });

  it("bpsBetween", () => {
    expect(bpsBetween(101, 100)).toBeCloseTo(100);
    expect(bpsBetween(100, 0)).toBe(Infinity);
  });

  it("expandEnvRef", () => {
    process.env.__PAUSER_TEST = "hello";
    expect(expandEnvRef("env:__PAUSER_TEST", "t")).toBe("hello");
    expect(expandEnvRef("plain-value", "t")).toBe("plain-value");
    expect(() => expandEnvRef("env:__PAUSER_MISSING", "t")).toThrow();
    delete process.env.__PAUSER_TEST;
  });
});
