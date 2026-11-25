import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { DISC_NAMES, TAMPER_DISCS, extractHadronIxs } from "../src/chain/txs.js";

const PROGRAM = "HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8";
const CONFIG = "6rK6f3zsp744uxhzA9n9rrzbpf4CvBy7oj3eaRrLogxL";

/** [disc][x_amount u64 LE][y_amount u64 LE][expiration i64 LE] */
function lpData(disc: number, x: bigint, y: bigint): Uint8Array {
  const b = Buffer.alloc(25);
  b.writeUInt8(disc, 0);
  b.writeBigUInt64LE(x, 1);
  b.writeBigUInt64LE(y, 9);
  b.writeBigInt64LE(0n, 17);
  return Uint8Array.from(b);
}

function update(data: Uint8Array, opts?: { err?: unknown }) {
  return {
    transaction: {
      slot: 1234,
      transaction: {
        // Short on purpose: a realistic 64-byte signature is ~88 base58 chars,
        // which the release credential scan (rightly) flags as key-shaped.
        signature: bs58.decode("4PL7ABTd"),
        meta: { err: opts?.err ?? null, innerInstructions: [] },
        transaction: {
          message: {
            accountKeys: [bs58.decode(PROGRAM), bs58.decode(CONFIG)],
            instructions: [{ programIdIndex: 0, accounts: [1], data }],
          },
        },
      },
    },
  };
}

describe("liquidity-flow parsing", () => {
  it("extracts amounts from a Deposit (disc 1)", () => {
    const [ev] = extractHadronIxs(update(lpData(1, 1_500_000_000n, 250_000_000n)), PROGRAM);
    expect(ev.name).toBe("Deposit");
    expect(ev.lp).toEqual({ isDeposit: true, xAmount: 1_500_000_000n, yAmount: 250_000_000n });
    expect(ev.accounts).toContain(CONFIG);
  });

  it("extracts amounts from a Withdraw (disc 2)", () => {
    const [ev] = extractHadronIxs(update(lpData(2, 7n, 9n)), PROGRAM);
    expect(ev.name).toBe("Withdraw");
    expect(ev.lp).toEqual({ isDeposit: false, xAmount: 7n, yAmount: 9n });
  });

  it("ignores a FAILED liquidity tx (no balances moved, so no adjustment)", () => {
    const [ev] = extractHadronIxs(update(lpData(2, 7n, 9n), { err: { InstructionError: [0, { Custom: 16 }] } }), PROGRAM);
    expect(ev.failed).toBe(true);
    expect(ev.lp).toBeUndefined();
  });

  it("does not attach lp data to non-liquidity instructions", () => {
    const swap = Uint8Array.from(Buffer.concat([Buffer.from([3]), Buffer.alloc(24)]));
    const [ev] = extractHadronIxs(update(swap), PROGRAM);
    expect(ev.name).toBe("SwapExactIn");
    expect(ev.lp).toBeUndefined();
  });

  it("ignores instructions from other programs", () => {
    expect(extractHadronIxs(update(lpData(1, 1n, 1n)), "SomeOtherProgram1111111111111111111111111111")).toHaveLength(0);
  });
});

describe("V2 discriminators (39-43)", () => {
  it("names the V2 instructions instead of Unknown(n)", () => {
    const names = [39, 40, 41, 42, 43].map(
      (d) => extractHadronIxs(update(Uint8Array.from([d])), PROGRAM)[0].name,
    );
    expect(names).toEqual([
      "UpdateRefillConfig",
      "RefillPriceDepth",
      "SetSpreadInitAllowance",
      "CloseSpreadConfig",
      "SyncProgramVersion",
    ]);
    expect(DISC_NAMES[44]).toBeUndefined();
  });

  it("treats 39/41/42 as tamper, not the routine refill (40) or permissionless sync (43)", () => {
    for (const d of [39, 41, 42]) expect(TAMPER_DISCS.has(d)).toBe(true);
    for (const d of [40, 43]) expect(TAMPER_DISCS.has(d)).toBe(false);
  });
});
