import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Multi-endpoint RPC access. First URL is primary; reads fall back down the
 * list; pause broadcasts go to every endpoint at once (see pause.ts).
 */
export class RpcPool {
  readonly connections: Connection[];

  constructor(urls: string[]) {
    if (urls.length === 0) throw new Error("RpcPool needs at least one URL");
    this.connections = urls.map((u) => new Connection(u, { commitment: "confirmed" }));
  }

  get primary(): Connection {
    return this.connections[0];
  }

  /** Try each endpoint in order until one succeeds. */
  async withFallback<T>(label: string, fn: (conn: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const conn of this.connections) {
      try {
        return await fn(conn);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`${label} failed on all ${this.connections.length} RPCs: ${(lastErr as Error)?.message}`);
  }

  /** getMultipleAccountsInfo, chunked, with fallback. Returns data or null per key. */
  async fetchAccounts(pubkeys: PublicKey[]): Promise<(Buffer | null)[]> {
    return (await this.fetchAccountsWithContext(pubkeys)).map((r) => r.data);
  }

  /**
   * Same, but carrying the slot each read was taken at.
   *
   * Callers that feed a live stream MUST use this: an RPC read routinely lags
   * the stream, so applying it without a slot lets stale bytes overwrite
   * fresher state and produce phantom transitions.
   */
  async fetchAccountsWithContext(
    pubkeys: PublicKey[],
  ): Promise<Array<{ data: Buffer | null; slot: number }>> {
    const out: Array<{ data: Buffer | null; slot: number }> = [];
    for (let i = 0; i < pubkeys.length; i += 100) {
      const chunk = pubkeys.slice(i, i + 100);
      const res = await this.withFallback("getMultipleAccountsInfo", (c) =>
        c.getMultipleAccountsInfoAndContext(chunk, "confirmed"),
      );
      for (const info of res.value) {
        out.push({ data: info ? Buffer.from(info.data) : null, slot: res.context.slot });
      }
    }
    return out;
  }

  async fetchBalanceSol(pubkey: PublicKey): Promise<number> {
    const lamports = await this.withFallback("getBalance", (c) => c.getBalance(pubkey));
    return lamports / 1e9;
  }
}
