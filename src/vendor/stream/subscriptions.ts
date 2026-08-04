/**
 * Yellowstone SubscribeRequest builders, shared across Hadron stream consumers.
 *
 * Each service composes its OWN request (the filters *are* the service) — these
 * helpers just fill the present-but-empty filter maps the client requires
 * (`transactionsStatus`, `blocks`, `blocksMeta`, `entry`, …) so callers only
 * specify what they care about. Field shapes mirror the hadron-ingestor producer.
 */
import { loadYellowstoneModule } from "./yellowstone.js";

export type Commitment = "processed" | "confirmed" | "finalized";

/** A named account subscription (by owner program and/or specific accounts). */
export interface AccountSub {
  /** Programs whose owned accounts to stream (e.g. the Hadron program id). */
  owner?: string[];
  /** Specific account pubkeys to stream (e.g. a ProgramData PDA, a FeeConfig PDA). */
  account?: string[];
  /** Memcmp / datasize filters. */
  filters?: any[];
  /** Only deliver updates whose write had a (non-empty) tx signature. */
  nonemptyTxnSignature?: boolean;
}

/** A named transaction subscription. */
export interface TransactionSub {
  vote?: boolean;
  failed?: boolean;
  signature?: string;
  accountInclude?: string[];
  accountExclude?: string[];
  accountRequired?: string[];
}

export interface SubscribeSpec {
  /** Commitment level. Default "confirmed" (producer parity). */
  commitment?: Commitment;
  /** Named account subscriptions. */
  accounts?: Record<string, AccountSub>;
  /** Named transaction subscriptions. */
  transactions?: Record<string, TransactionSub>;
  /** Subscribe to slot updates (drives gap detection). Default false. */
  slots?: boolean;
  /** Optional accounts data slices (advanced). */
  accountsDataSlice?: any[];
}

function normAccount(a: AccountSub) {
  return {
    owner: a.owner ?? [],
    account: a.account ?? [],
    filters: a.filters ?? [],
    nonemptyTxnSignature: a.nonemptyTxnSignature,
  };
}

function normTxn(t: TransactionSub) {
  return {
    vote: t.vote ?? false,
    failed: t.failed ?? false,
    signature: t.signature,
    accountInclude: t.accountInclude ?? [],
    accountExclude: t.accountExclude ?? [],
    accountRequired: t.accountRequired ?? [],
  };
}

/**
 * Compose a full Yellowstone SubscribeRequest from the parts you care about.
 *
 * @example
 * buildRequest: () => buildSubscribeRequest({
 *   accounts: {
 *     programData: { account: [programDataPda] },
 *     feeConfig:   { account: [feeConfigPda] },
 *     multisigs:   { account: multisigPubkeys },
 *   },
 *   transactions: {
 *     governance: { accountInclude: [hadronProgramId, ...multisigPubkeys] },
 *   },
 *   slots: true,
 * })
 */
export async function buildSubscribeRequest(spec: SubscribeSpec): Promise<any> {
  const grpcModule = await loadYellowstoneModule();
  const { CommitmentLevel } = grpcModule;
  const commitment =
    spec.commitment === "processed"
      ? CommitmentLevel.PROCESSED
      : spec.commitment === "finalized"
        ? CommitmentLevel.FINALIZED
        : CommitmentLevel.CONFIRMED;

  const accounts: Record<string, any> = {};
  for (const [name, sub] of Object.entries(spec.accounts ?? {})) {
    accounts[name] = normAccount(sub);
  }
  const transactions: Record<string, any> = {};
  for (const [name, sub] of Object.entries(spec.transactions ?? {})) {
    transactions[name] = normTxn(sub);
  }

  return {
    commitment,
    accountsDataSlice: spec.accountsDataSlice ?? [],
    ping: undefined,
    accounts,
    slots: spec.slots ? { slotUpdates: { filterByCommitment: true } } : {},
    transactions,
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };
}

/**
 * A ping-only SubscribeRequest used as a stream keepalive (the "stream-ping"
 * keepalive mode). All filter maps are present-but-empty (the client requires
 * them) and `ping` marks it as a keepalive — the server replies with a pong and
 * does NOT alter the active subscription. Works on providers that don't expose
 * the unary `client.ping()` RPC.
 */
export function buildPingRequest(id: number): any {
  return {
    ping: { id },
    accounts: {},
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    slots: {},
  };
}
