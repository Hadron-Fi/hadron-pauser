import { describe, expect, it } from "vitest";
import {
  AuthorityCtx,
  classifyFieldChange,
} from "../src/engine/detectors/authority-change.js";

const OUR_PAUSER = "PauserKey11111111111111111111111111111111111";
const OLD_QUOTER = "OldQuoter1111111111111111111111111111111111";
const NEW_QUOTER = "NewQuoter1111111111111111111111111111111111";

function ctx(over?: Partial<AuthorityCtx>): AuthorityCtx {
  return {
    poolName: "test",
    pauserPubkey: OUR_PAUSER,
    pauseOnChange: true,
    expectedQuotingAuthorities: new Set([OLD_QUOTER]),
    ...over,
  };
}

function change(field: string, oldValue: string, newValue: string) {
  return { field, oldValue, newValue, slot: 123 };
}

describe("authority change classification", () => {
  it("unexpected quoting authority rotation is pause-tier", () => {
    const v = classifyFieldChange(change("oracleAuthority", OLD_QUOTER, NEW_QUOTER), ctx());
    expect(v?.level).toBe("pause");
    expect(v?.severity).toBe("critical");
    expect(v?.code).toBe("quoting-auth-rotated");
  });

  it("allowlisted quoting authority rotation is informational", () => {
    const v = classifyFieldChange(
      change("oracleAuthority", OLD_QUOTER, NEW_QUOTER),
      ctx({ expectedQuotingAuthorities: new Set([OLD_QUOTER, NEW_QUOTER]) }),
    );
    expect(v?.level).toBe("alert");
    expect(v?.severity).toBe("info");
  });

  it("pauseOnChange=false downgrades to critical alert", () => {
    const v = classifyFieldChange(
      change("oracleAuthority", OLD_QUOTER, NEW_QUOTER),
      ctx({ pauseOnChange: false }),
    );
    expect(v?.level).toBe("alert");
    expect(v?.severity).toBe("critical");
  });

  it("pause authority rotated away from us is critical", () => {
    const v = classifyFieldChange(change("pauseAuthority", OUR_PAUSER, NEW_QUOTER), ctx());
    expect(v?.code).toBe("pauser-rotated-away");
    expect(v?.severity).toBe("critical");
  });

  it("pause authority rotated TO us is info", () => {
    const v = classifyFieldChange(change("pauseAuthority", NEW_QUOTER, OUR_PAUSER), ctx());
    expect(v?.code).toBe("pauser-installed");
    expect(v?.severity).toBe("info");
  });

  it("delta_staleness -> 0 is critical (staleness gate disabled)", () => {
    const v = classifyFieldChange(change("deltaStaleness", "150", "0"), ctx());
    expect(v?.severity).toBe("critical");
    expect(v?.message).toContain("DISABLED");
  });

  it("guard threshold widened is critical, tightened is warning", () => {
    expect(classifyFieldChange(change("thresholdBps", "150", "500"), ctx())?.severity).toBe("critical");
    expect(classifyFieldChange(change("thresholdBps", "150", "100"), ctx())?.severity).toBe("warning");
    expect(classifyFieldChange(change("thresholdBps", "150", "0"), ctx())?.severity).toBe("critical");
  });

  it("state transitions classify", () => {
    expect(classifyFieldChange(change("state", "1", "2"), ctx())?.code).toBe("pool-paused-externally");
    expect(classifyFieldChange(change("state", "2", "1"), ctx())?.code).toBe("pool-unpaused");
    expect(classifyFieldChange(change("state", "1", "4"), ctx())?.severity).toBe("critical");
    expect(classifyFieldChange(change("state", "1", "3"), ctx())?.code).toBe("pool-reject-swaps");
  });

  it("unknown fields are ignored", () => {
    expect(classifyFieldChange(change("hwmBaseCurrent", "1", "2"), ctx())).toBeNull();
  });
});
