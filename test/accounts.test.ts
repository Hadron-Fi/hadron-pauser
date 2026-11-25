import { describe, expect, it } from "vitest";
import { CONFIG_SIZE, decodeConfigSnapshot } from "../src/chain/accounts.js";

/** Minimal Config account: state Initialized, staleness split low @139 / high @143. */
function configBytes(low: number, high: number): Uint8Array {
  const b = Buffer.alloc(CONFIG_SIZE);
  b.writeUInt8(1, 0);
  b.writeUInt8(low, 139);
  b.writeUInt8(high, 143);
  return Uint8Array.from(b);
}

describe("delta_staleness decode", () => {
  it("V1 layout (byte 143 = padding, always 0) reads the u8 unchanged", () => {
    expect(decodeConfigSnapshot(configBytes(150, 0)).deltaStaleness).toBe(150);
    expect(decodeConfigSnapshot(configBytes(0, 0)).deltaStaleness).toBe(0);
  });

  it("V2 layout reads a u16 with its high byte at Config byte 143", () => {
    expect(decodeConfigSnapshot(configBytes(0x2c, 0x01)).deltaStaleness).toBe(300);
    expect(decodeConfigSnapshot(configBytes(0xff, 0xff)).deltaStaleness).toBe(65535);
  });

  it("a high-byte-only value is not mistaken for 0 (gate disabled)", () => {
    expect(decodeConfigSnapshot(configBytes(0, 1)).deltaStaleness).toBe(256);
  });
});
