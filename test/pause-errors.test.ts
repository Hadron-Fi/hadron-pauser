import { describe, expect, it } from "vitest";
import { classifyPauseError, extractCustomCode } from "../src/chain/pause.js";

describe("pause error classification (set_pool_state.rs error map)", () => {
  it("Custom(53) InvalidPoolState = benign no-op (guard beat us)", () => {
    expect(classifyPauseError({ InstructionError: [0, { Custom: 53 }] })).toBe("already-paused");
  });
  it("Custom(71) PoolAlreadyClosed = benign", () => {
    expect(classifyPauseError({ InstructionError: [2, { Custom: 71 }] })).toBe("pool-closed");
  });
  it("Custom(4) Unauthorized = we were rotated away (critical)", () => {
    expect(classifyPauseError({ InstructionError: [0, { Custom: 4 }] })).toBe("unauthorized");
  });
  it("anything else = failed", () => {
    expect(classifyPauseError({ InstructionError: [0, { Custom: 48 }] })).toBe("failed");
    expect(classifyPauseError("BlockhashNotFound")).toBe("failed");
  });
  it("parses hex custom codes from log strings", () => {
    expect(extractCustomCode("failed: custom program error: 0x35")).toBe(53);
    expect(extractCustomCode("failed: custom program error: 0x4")).toBe(4);
    expect(extractCustomCode("no code here")).toBeNull();
  });
});
