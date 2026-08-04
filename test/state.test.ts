import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SNAPSHOT_VERSION,
  baselineFields,
  diffBaseline,
  downsampleWindow,
  isValidSnapshot,
} from "../src/state/snapshot.js";
import { FileSnapshotStore } from "../src/state/store.js";
import { ConfigSnapshot } from "../src/chain/accounts.js";

const dir = mkdtempSync(join(tmpdir(), "pauser-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeConfig(over?: Partial<ConfigSnapshot>): ConfigSnapshot {
  return {
    state: 1,
    seed: 1n,
    authority: "admin",
    pendingAuthority: "",
    mintX: "mx",
    mintY: "my",
    curveMeta: "cm",
    deltaStaleness: 150,
    tokenProgramX: "tp",
    tokenProgramY: "tp",
    depositAuthority: "dep",
    withdrawAuthority: "wd",
    pauseAuthority: "pauser",
    hwmBaseCurrent: 0n,
    hwmBasePrevious: 0n,
    hwmQuoteCurrent: 0n,
    hwmQuotePrevious: 0n,
    lastRotationSlot: 0,
    rotationIntervalSlots: 0,
    thresholdBps: 0,
    ...over,
  };
}

describe("snapshot state", () => {
  it("downsampling preserves per-denomination window maxima exactly", () => {
    const window = [
      { ts: 1_000, eBase: 100, eQuote: 900 },
      { ts: 30_000, eBase: 105, eQuote: 880 }, // same minute bucket
      { ts: 59_000, eBase: 99, eQuote: 950 },
      { ts: 61_000, eBase: 98, eQuote: 700 }, // next bucket
    ];
    const ds = downsampleWindow(window, 60_000);
    expect(ds).toHaveLength(2);
    expect(Math.max(...ds.map((s) => s.eBase))).toBe(105);
    expect(Math.max(...ds.map((s) => s.eQuote))).toBe(950);
    expect(ds[0].ts).toBeLessThan(ds[1].ts); // sorted
  });

  it("baseline diff flags exactly the changed fields (downtime detection)", () => {
    const before = baselineFields(fakeConfig(), "quoterA");
    const after = baselineFields(fakeConfig({ deltaStaleness: 0 }), "quoterB");
    const changes = diffBaseline(before, after);
    expect(changes.map((c) => c.field).sort()).toEqual(["deltaStaleness", "oracleAuthority"]);
    const rot = changes.find((c) => c.field === "oracleAuthority")!;
    expect(rot.oldValue).toBe("quoterA");
    expect(rot.newValue).toBe("quoterB");
    expect(diffBaseline(before, before)).toHaveLength(0);
  });

  it("file store round-trips and returns null for missing/invalid", async () => {
    const store = new FileSnapshotStore(join(dir, "snap.json"));
    expect(await store.load()).toBeNull();
    const snap = {
      version: SNAPSHOT_VERSION,
      savedAt: 123,
      pools: { pda: { window: [{ ts: 1, eBase: 2, eQuote: 3 }], fields: { state: "1" } } },
    };
    await store.save(snap);
    expect(await store.load()).toEqual(snap);
    const bad = new FileSnapshotStore(join(dir, "bad.json"));
    await bad.save({ version: 999, savedAt: 1, pools: {} } as never);
    expect(await bad.load()).toBeNull(); // wrong version rejected
  });

  it("isValidSnapshot rejects junk", () => {
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot({ version: SNAPSHOT_VERSION })).toBe(false);
    expect(isValidSnapshot({ version: SNAPSHOT_VERSION, savedAt: 1, pools: {} })).toBe(true);
  });
});
