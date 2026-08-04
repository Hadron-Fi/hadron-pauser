import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { PoolState, buildSetPoolState } from "@hadron-fi/sdk-v2";
import { RpcPool } from "./rpc.js";
import { decodeConfigSnapshot } from "./accounts.js";

/**
 * The action path. Builds SetPoolState(21, Paused), signs with the pauser key,
 * broadcasts to every RPC at once, and confirms by polling signature statuses
 * (never websocket confirms — known false-expiry failure mode).
 *
 * Program facts this encodes (src/instructions/set_pool_state.rs):
 *  - pause authority may only do Initialized(1)|RejectSwaps(3) -> Paused(2)
 *  - Custom(53) InvalidPoolState = no-op/already latched  -> benign
 *  - Custom(71) PoolAlreadyClosed                          -> benign (nothing to protect)
 *  - Custom(4)  Unauthorized = our key was rotated away    -> critical
 */

export type PauseOutcome =
  | "paused"
  | "already-paused"
  | "pool-closed"
  | "unauthorized"
  | "failed";

export interface PauseResult {
  outcome: PauseOutcome;
  signature?: string;
  detail: string;
}

/** Classify a confirmed-transaction error object into a pause outcome. */
export function classifyPauseError(err: unknown): PauseOutcome {
  const custom = extractCustomCode(err);
  if (custom === 53) return "already-paused";
  if (custom === 71) return "pool-closed";
  if (custom === 4) return "unauthorized";
  return "failed";
}

export function extractCustomCode(err: unknown): number | null {
  if (err == null) return null;
  // Shapes: {InstructionError:[0,{Custom:53}]} or a string containing "custom program error: 0x35"
  const anyErr = err as any;
  const ie = anyErr.InstructionError;
  if (Array.isArray(ie) && ie[1] && typeof ie[1] === "object" && "Custom" in ie[1]) {
    return Number(ie[1].Custom);
  }
  const text = typeof err === "string" ? err : JSON.stringify(err);
  const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(text);
  if (m) return parseInt(m[1], 16);
  return null;
}

export interface PauseExecutorOptions {
  cuPriceMicroLamports: number;
  confirmTimeoutMs?: number;
  rebroadcastMs?: number;
}

export class PauseExecutor {
  constructor(
    private readonly rpc: RpcPool,
    private readonly signer: Keypair,
    private readonly programId: PublicKey,
    private readonly opts: PauseExecutorOptions,
  ) {}

  get pauserPubkey(): PublicKey {
    return this.signer.publicKey;
  }

  /**
   * Pause `configPda`. Re-reads state immediately before sending so a guard
   * trip that beat us is reported as benign rather than as a failed tx.
   */
  async pause(configPda: PublicKey, curveMeta: PublicKey): Promise<PauseResult> {
    const fresh = await this.rpc.withFallback("pre-pause config read", (c) =>
      c.getAccountInfo(configPda, "confirmed"),
    );
    if (!fresh) return { outcome: "failed", detail: "config account missing" };
    const state = decodeConfigSnapshot(Uint8Array.from(fresh.data)).state;
    if (state === 2) return { outcome: "already-paused", detail: "state already Paused" };
    if (state === 4) return { outcome: "pool-closed", detail: "pool is Closed" };
    if (state !== 1 && state !== 3) {
      return { outcome: "failed", detail: `unexpected pool state ${state}` };
    }

    const ix = buildSetPoolState(
      this.signer.publicKey,
      configPda,
      curveMeta,
      { newState: PoolState.Paused },
      this.programId,
    );
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));
    if (this.opts.cuPriceMicroLamports > 0) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.opts.cuPriceMicroLamports,
        }),
      );
    }
    tx.add(ix);

    const { blockhash, lastValidBlockHeight } = await this.rpc.withFallback(
      "getLatestBlockhash",
      (c) => c.getLatestBlockhash("confirmed"),
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.signer.publicKey;
    tx.sign(this.signer);
    const raw = tx.serialize();
    const signature = await this.broadcast(raw);
    return this.confirm(signature, raw, lastValidBlockHeight);
  }

  /** Fire the raw tx at every endpoint; first successful send wins the sig. */
  private async broadcast(raw: Buffer): Promise<string> {
    const sends = this.rpc.connections.map((c) =>
      c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
    );
    const results = await Promise.allSettled(sends);
    for (const r of results) if (r.status === "fulfilled") return r.value;
    const first = results[0] as PromiseRejectedResult;
    throw new Error(`broadcast failed on all RPCs: ${first.reason}`);
  }

  private async confirm(
    signature: string,
    raw: Buffer,
    lastValidBlockHeight: number,
  ): Promise<PauseResult> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 45_000;
    const rebroadcastMs = this.opts.rebroadcastMs ?? 2_000;
    const started = Date.now();
    let lastRebroadcast = started;

    while (Date.now() - started < timeoutMs) {
      const status = await this.pollStatus(signature);
      if (status) {
        if (status.err != null) {
          const outcome = classifyPauseError(status.err);
          return { outcome, signature, detail: `tx error ${JSON.stringify(status.err)}` };
        }
        return { outcome: "paused", signature, detail: `confirmed (${status.confirmationStatus})` };
      }
      const height = await this.safeBlockHeight();
      if (height != null && height > lastValidBlockHeight) {
        return { outcome: "failed", signature, detail: "blockhash expired before confirmation" };
      }
      if (Date.now() - lastRebroadcast >= rebroadcastMs) {
        lastRebroadcast = Date.now();
        await Promise.allSettled(
          this.rpc.connections.map((c) =>
            c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
          ),
        );
      }
      await sleep(400);
    }
    return { outcome: "failed", signature, detail: "confirmation timed out" };
  }

  private async pollStatus(signature: string) {
    for (const c of this.rpc.connections) {
      try {
        const res = await c.getSignatureStatuses([signature]);
        const st = res.value[0];
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" || st.err != null)) {
          return st;
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  private async safeBlockHeight(): Promise<number | null> {
    try {
      return await this.rpc.withFallback("getBlockHeight", (c) => c.getBlockHeight("confirmed"));
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
