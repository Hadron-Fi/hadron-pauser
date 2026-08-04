import bs58 from "bs58";

/**
 * Light-weight classifier for Hadron instructions inside a Yellowstone
 * transaction update. Pattern follows services/hadron-ingestor: build the full
 * (ALT-aware) key list, flatten top-level + inner instructions so CPI'd calls
 * from aggregators are caught, match on programId + 1-byte discriminator.
 *
 * Quote pushes (discs 5/9/10) run on the program's log-free hot path — this
 * classifier (instruction data), never log parsing, is the reliable signal.
 */

/** Discriminator -> name (audited Hadron program source, current tree). */
export const DISC_NAMES: Record<number, string> = {
  0: "Initialize",
  1: "Deposit",
  2: "Withdraw",
  3: "SwapExactIn",
  4: "SetCurve",
  5: "UpdateMidprice",
  6: "InitializeFeeConfig",
  7: "UpdateFeeConfig",
  8: "SetRiskCurve",
  9: "UpdateSpreadFactor",
  10: "UpdateMidpriceAndSpreadFactor",
  11: "SwitchPriceCurve",
  12: "SwitchRiskCurve",
  13: "InitializeSpreadConfig",
  14: "UpdateSpreadConfig",
  15: "UpdateDeltaStaleness",
  16: "NominateAuthority",
  17: "AcceptAuthority",
  18: "SubmitCurveUpdates",
  19: "ApplyCurveUpdates",
  20: "ClosePool",
  21: "SetPoolState",
  22: "AllocateCurvePrefabs",
  24: "RotateFeeAdmin",
  25: "InitializePoolFeeConfig",
  26: "UpdatePoolFeeConfig",
  27: "SetAssetFee",
  28: "ValidateCurveUpdates",
  29: "RemoveSpreadTriggers",
  30: "UpdateDrawdownGuard",
  31: "UpdateFactorClamp",
  32: "ClosePoolFeeConfig",
  33: "RotateDepositAuthority",
  34: "RotateWithdrawAuthority",
  35: "RotateQuotingAuthority",
  36: "RotateSpreadAdmin",
  37: "RotatePauseAuthority",
  38: "PokeDrawdownGuard",
};

/** Discs that change authorities/protections — always alert-worthy. */
export const TAMPER_DISCS = new Set([15, 16, 17, 20, 21, 30, 33, 34, 35, 36, 37]);

/**
 * Liquidity flow carried by a Deposit (disc 1) or Withdraw (disc 2).
 * Data layout after the discriminator byte (withdraw.rs:99-101, and the same
 * `x_amount`/`y_amount` fields on deposit.rs:83-84):
 *   x_amount u64 LE @0 | y_amount u64 LE @8 | expiration i64 LE @16
 */
export interface LpFlow {
  isDeposit: boolean;
  xAmount: bigint;
  yAmount: bigint;
}

export interface HadronIxEvent {
  signature: string;
  slot: number;
  disc: number;
  name: string;
  /** account[0] of the instruction — the signing authority for admin/quote ixs */
  authority: string | null;
  /** resolved account pubkeys of the instruction, in order */
  accounts: string[];
  failed: boolean;
  inner: boolean;
  /** present for successful Deposit/Withdraw only */
  lp?: LpFlow;
}

function parseLpFlow(disc: number, data: Uint8Array): LpFlow | undefined {
  if (disc !== 1 && disc !== 2) return undefined;
  if (data.length < 17) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    isDeposit: disc === 1,
    xAmount: view.getBigUint64(1, true),
    yAmount: view.getBigUint64(9, true),
  };
}

function toB58(k: unknown): string {
  if (typeof k === "string") return k;
  return bs58.encode(k as Uint8Array);
}

/**
 * Extract all Hadron instructions from a Yellowstone `SubscribeUpdateTransaction`.
 * Defensive about shape: returns [] rather than throwing on unexpected updates.
 */
export function extractHadronIxs(update: unknown, programId: string): HadronIxEvent[] {
  const u = update as any;
  const wrap = u?.transaction;
  const inner = wrap?.transaction;
  const msg = inner?.transaction?.message;
  if (!msg?.accountKeys || !msg?.instructions) return [];

  const meta = inner.meta ?? {};
  const keys: string[] = [
    ...msg.accountKeys.map(toB58),
    ...(meta.loadedWritableAddresses ?? []).map(toB58),
    ...(meta.loadedReadonlyAddresses ?? []).map(toB58),
  ];

  const slot = Number(wrap.slot ?? 0);
  const signature = inner.signature ? toB58(inner.signature) : "";
  const failed = meta.err != null;

  type RawIx = { programIdIndex: number; accounts: Uint8Array | number[]; data: Uint8Array };
  const all: Array<{ ix: RawIx; inner: boolean }> = [];
  for (const ix of msg.instructions as RawIx[]) all.push({ ix, inner: false });
  for (const group of meta.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) all.push({ ix, inner: true });
  }

  const out: HadronIxEvent[] = [];
  for (const { ix, inner: isInner } of all) {
    const pid = keys[ix.programIdIndex];
    if (pid !== programId) continue;
    const data = ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data ?? []);
    if (data.length === 0) continue;
    const disc = data[0];
    const idxs = Array.from(ix.accounts ?? []);
    const accounts = idxs.map((i) => keys[i] ?? "?");
    out.push({
      signature,
      slot,
      disc,
      name: DISC_NAMES[disc] ?? `Unknown(${disc})`,
      authority: accounts[0] ?? null,
      accounts,
      failed,
      inner: isInner,
      lp: failed ? undefined : parseLpFlow(disc, data),
    });
  }
  return out;
}
