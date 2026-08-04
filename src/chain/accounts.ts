import { PublicKey } from "@solana/web3.js";
import {
  CONFIG_SIZE,
  HADRON_PROGRAM_ID,
  MIDPRICE_ORACLE_SIZE,
  PoolState,
  decodeConfig,
  decodeMidpriceOracle,
} from "@hadron-fi/sdk-v2";
import { q32ToNumber, u128LE } from "../util.js";

export { CONFIG_SIZE, MIDPRICE_ORACLE_SIZE, PoolState };

/** sdk-v2 decoders return PublicKey-ish values; normalize to base58 strings. */
function b58(v: unknown): string {
  if (v == null) return "";
  const anyV = v as { toBase58?: () => string };
  return typeof anyV.toBase58 === "function" ? anyV.toBase58() : String(v);
}

function asNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

function asBig(v: unknown): bigint {
  return typeof v === "bigint" ? v : BigInt(asNum(v));
}

/**
 * The Config fields the pauser watches, normalized to plain JS values so
 * snapshots diff with ===. Offsets/semantics: the audited Hadron program
 * source, src/state/config.rs (724-byte account).
 */
export interface ConfigSnapshot {
  state: number; // PoolState: 1 Initialized, 2 Paused, 3 RejectSwaps, 4 Closed
  seed: bigint;
  authority: string; // pool admin
  pendingAuthority: string;
  mintX: string;
  mintY: string;
  curveMeta: string; // required account for SetPoolState
  deltaStaleness: number; // slots, 0 = staleness gate disabled
  tokenProgramX: string;
  tokenProgramY: string;
  depositAuthority: string;
  withdrawAuthority: string;
  pauseAuthority: string;
  // drawdown guard block
  hwmBaseCurrent: bigint;
  hwmBasePrevious: bigint;
  hwmQuoteCurrent: bigint;
  hwmQuotePrevious: bigint;
  lastRotationSlot: number;
  rotationIntervalSlots: number;
  thresholdBps: number;
}

export function decodeConfigSnapshot(data: Uint8Array): ConfigSnapshot {
  const c = decodeConfig(data);
  return {
    state: asNum(c.state),
    seed: asBig(c.seed),
    authority: b58(c.authority),
    pendingAuthority: b58(c.pendingAuthority),
    mintX: b58(c.mintX),
    mintY: b58(c.mintY),
    curveMeta: b58(c.curveMeta),
    deltaStaleness: asNum(c.deltaStaleness),
    tokenProgramX: b58(c.tokenProgramX),
    tokenProgramY: b58(c.tokenProgramY),
    depositAuthority: b58(c.depositAuthority),
    withdrawAuthority: b58(c.withdrawAuthority),
    pauseAuthority: b58(c.pauseAuthority),
    hwmBaseCurrent: u128LE(c.hwmBaseCurrent),
    hwmBasePrevious: u128LE(c.hwmBasePrevious),
    hwmQuoteCurrent: u128LE(c.hwmQuoteCurrent),
    hwmQuotePrevious: u128LE(c.hwmQuotePrevious),
    lastRotationSlot: asNum(c.lastRotationSlot),
    rotationIntervalSlots: asNum(c.rotationIntervalSlots),
    thresholdBps: asNum(c.thresholdBps),
  };
}

export interface OracleSnapshot {
  authority: string; // the quoting/oracle authority — v1 headline watch field
  sequence: bigint;
  midAtomRatio: number; // quote atoms per base atom (Q32.32 -> float)
  spreadFactorQ32: bigint;
  lastUpdateSlot: number;
}

export function decodeOracleSnapshot(data: Uint8Array): OracleSnapshot {
  const o = decodeMidpriceOracle(data);
  return {
    authority: b58(o.authority),
    sequence: asBig(o.sequence),
    midAtomRatio: q32ToNumber(asBig(o.midpriceQ32)),
    spreadFactorQ32: asBig(o.spreadFactorQ32),
    lastUpdateSlot: asNum(o.lastUpdateSlot),
  };
}

/** SPL token account amount (u64 LE @64). Works for Token and Token-2022. */
export function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error(`token account too short: ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}

/** Mint decimals live at byte 44 for both token programs. */
export function decodeMintDecimals(data: Uint8Array): number {
  if (data.length < 45) throw new Error(`mint account too short: ${data.length}`);
  return data[44];
}

function seedLe8(seed: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(seed);
  return buf;
}

/**
 * MidpriceOracle PDA: ["hadron-midprice", seed_le8, mint_x, mint_y]
 * (src/instructions/helpers/pda.rs). Derived here rather than stored in Config.
 */
export function deriveOraclePda(cfg: ConfigSnapshot, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("hadron-midprice"),
      seedLe8(cfg.seed),
      new PublicKey(cfg.mintX).toBuffer(),
      new PublicKey(cfg.mintY).toBuffer(),
    ],
    programId,
  )[0];
}

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * ATA derivation, hand-rolled on web3.js alone.
 *
 * Deliberately not `@solana/spl-token`'s `getAssociatedTokenAddressSync`: that
 * import pulls in buffer-layout-utils -> bigint-buffer, whose native binding
 * fails to load in slim/alpine containers. It degrades to pure JS and still
 * works, but it prints a "Failed to load bindings" warning as the very first
 * line of the service log, and the same dependency has broken other runtimes
 * outright. One PDA derivation is not worth that.
 *
 * Seeds are [owner, tokenProgram, mint] — note the owner here is the Config
 * PDA (off-curve), which is why the spl-token variant needed allowOwnerOffCurve.
 * findProgramAddressSync has no such restriction.
 */
export function deriveAta(owner: PublicKey, tokenProgram: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Vaults are ATAs of the config PDA (owner off-curve). Derived, never stored. */
export function deriveVaults(configPda: PublicKey, cfg: ConfigSnapshot): { vaultX: PublicKey; vaultY: PublicKey } {
  return {
    vaultX: deriveAta(configPda, new PublicKey(cfg.tokenProgramX), new PublicKey(cfg.mintX)),
    vaultY: deriveAta(configPda, new PublicKey(cfg.tokenProgramY), new PublicKey(cfg.mintY)),
  };
}

export function resolveProgramId(override?: string): PublicKey {
  return override ? new PublicKey(override) : new PublicKey(b58(HADRON_PROGRAM_ID));
}

export const POOL_STATE_NAMES: Record<number, string> = {
  0: "Uninitialized",
  1: "Initialized",
  2: "Paused",
  3: "RejectSwaps",
  4: "Closed",
};
