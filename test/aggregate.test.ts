import { describe, expect, it } from "vitest";
import { aggregateRefs } from "../src/refs/aggregate.js";
import { RefSample, RefSource } from "../src/refs/types.js";

function src(name: string, price: number | null, ageMs: number, staleMs = 10_000): RefSource {
  return {
    name,
    staleMs,
    start() {},
    stop() {},
    latest(): RefSample | null {
      return price == null ? null : { price, ts: 1_000_000 - ageMs };
    },
  };
}

const NOW = 1_000_000;

describe("ref aggregation", () => {
  it("median of fresh sources, ok quality", () => {
    const agg = aggregateRefs([src("a", 100, 0), src("b", 101, 0), src("c", 100.5, 0)], NOW, 2, 200);
    expect(agg.mid).toBe(100.5);
    expect(agg.quality).toBe("ok");
    expect(agg.freshCount).toBe(3);
  });

  it("stale sources are excluded", () => {
    const agg = aggregateRefs([src("a", 100, 0), src("b", 999, 60_000)], NOW, 1, 200);
    expect(agg.mid).toBe(100);
    expect(agg.freshCount).toBe(1);
  });

  it("below quorum degrades", () => {
    const agg = aggregateRefs([src("a", 100, 0), src("b", null, 0)], NOW, 2, 200);
    expect(agg.quality).toBe("degraded");
    expect(agg.reason).toContain("below_quorum");
    expect(agg.mid).toBe(100); // still reported for alerting
  });

  it("dispersion above max degrades", () => {
    const agg = aggregateRefs([src("a", 100, 0), src("b", 103, 0)], NOW, 2, 100);
    expect(agg.quality).toBe("degraded");
    expect(agg.reason).toContain("dispersion");
  });

  it("no fresh sources", () => {
    const agg = aggregateRefs([src("a", null, 0)], NOW, 1, 100);
    expect(agg.mid).toBeNull();
    expect(agg.quality).toBe("degraded");
    expect(agg.reason).toBe("no_fresh_sources");
  });
});
