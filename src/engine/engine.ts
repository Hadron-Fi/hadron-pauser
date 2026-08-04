import { PublicKey } from "@solana/web3.js";
import { AlertSink } from "../alerts.js";
import {
  ConfigSnapshot,
  OracleSnapshot,
  decodeConfigSnapshot,
  decodeOracleSnapshot,
  decodeTokenAmount,
  POOL_STATE_NAMES,
} from "../chain/accounts.js";
import { PauseExecutor } from "../chain/pause.js";
import { HadronIxEvent } from "../chain/txs.js";
import { PoolConfig } from "../config.js";
import { OnchainAccountRef, RefSource, aggregateRefs } from "../refs/index.js";
import {
  PauserSnapshot,
  SNAPSHOT_VERSION,
  WATCHED_CONFIG_FIELDS,
  baselineFields,
  diffBaseline,
  downsampleWindow,
} from "../state/snapshot.js";
import { atomRatioToUi } from "../util.js";
import { AuthorityCtx, FieldChange, classifyFieldChange } from "./detectors/authority-change.js";
import {
  DrawdownState,
  applyLiquidityFlow,
  evalDrawdown,
  initDrawdownState,
  resetWindow,
} from "./detectors/drawdown.js";
import { evalMidDeviation } from "./detectors/mid-deviation.js";
import { Verdict } from "./types.js";

/** Pause-tier codes gated by K-of-N tick persistence. Discrete authority
 *  verdicts act immediately instead (a field diff is a single event, not a
 *  flickering signal). */
const PAUSE_CODES = ["mid-deviation", "drawdown"] as const;

/** K-of-N persistence: a pause verdict must fire in PERSIST_TICKS of the last
 *  WINDOW_TICKS one-second evaluations before the action path runs. Fixed on
 *  purpose (anti-flicker, ~2-3s latency): real conditions are continuously
 *  true; this only rejects one-tick artifacts (a glitch ref print, vault and
 *  oracle updates landing a slot apart mid-swap). */
const PERSIST_TICKS = 3;
const WINDOW_TICKS = 5;

/** After a deposit/withdrawal, hold drawdown pause verdicts briefly: the vault
 *  account update and the transaction that explains it can arrive in either
 *  order, and we must not pause on the gap between them. */
const LP_SETTLE_MS = 10_000;

/**
 * A single-tick drop of this fraction of a vault is treated as an event that
 * needs explaining, not as instant drawdown.
 *
 * The stream delivers account writes and transaction notifications as
 * independent messages, and the account write for a withdrawal usually lands
 * FIRST — so balances can move before the transaction that explains them
 * arrives (or, across a reconnect, when it never arrives at all, since
 * reconcile re-reads accounts but cannot replay missed transactions).
 * Keying on balances rather than equity keeps ordinary price moves from
 * tripping this; a large swap may trip it, which costs nothing because a
 * fairly-priced swap produces no drawdown anyway.
 */
const BALANCE_JUMP_FRACTION = 0.02;

export interface PoolRuntime {
  cfg: PoolConfig;
  name: string;
  configPda: string;
  oraclePda: string;
  vaultX: string;
  vaultY: string;
  curveMeta: string;
  decBase: number;
  decQuote: number;
  refSources: RefSource[];
  /** onchain-account refs fed by the stream router (subset of refSources) */
  onchainRefs: Map<string, OnchainAccountRef>;
  expectedQuoting: Set<string>;

  // live state
  config: ConfigSnapshot | null;
  oracle: OracleSnapshot | null;
  baseAtoms: bigint | null;
  quoteAtoms: bigint | null;
  accountSlots: Map<string, number>;
  drawdown: DrawdownState;
  recentIxs: HadronIxEvent[];
  episodes: Map<string, { since: number; lastAlertAt: number }>;
  persist: Map<string, boolean[]>;
  lastPauseAttemptAt: number;
  /** drawdown pause verdicts are suppressed until this timestamp (LP settle) */
  lpSettleUntil: number;
  /** vault balances at the previous tick, for discontinuity detection */
  lastBalances: { base: bigint; quote: bigint } | null;
  pauseAttempts: number;
  pausedByUsSig: string | null;
  lastMetrics: Record<string, unknown>;
  pauseInFlight: boolean;
}

export function initPoolRuntime(
  base: Omit<
    PoolRuntime,
    | "config"
    | "oracle"
    | "baseAtoms"
    | "quoteAtoms"
    | "accountSlots"
    | "drawdown"
    | "recentIxs"
    | "episodes"
    | "persist"
    | "lastPauseAttemptAt"
    | "lpSettleUntil"
    | "lastBalances"
    | "pauseAttempts"
    | "pausedByUsSig"
    | "lastMetrics"
    | "pauseInFlight"
  >,
): PoolRuntime {
  return {
    ...base,
    config: null,
    oracle: null,
    baseAtoms: null,
    quoteAtoms: null,
    accountSlots: new Map(),
    drawdown: initDrawdownState(),
    recentIxs: [],
    episodes: new Map(),
    persist: new Map(),
    lastPauseAttemptAt: 0,
    lpSettleUntil: 0,
    lastBalances: null,
    pauseAttempts: 0,
    pausedByUsSig: null,
    lastMetrics: {},
    pauseInFlight: false,
  };
}

export interface EngineOptions {
  dryRun: boolean;
  warmupMs: number;
  pauseCooldownMs: number;
  /** re-alert cadence while a pause-tier episode stays active */
  reAlertMs?: number;
}

export class Engine {
  private readonly byAccount = new Map<
    string,
    { pool: PoolRuntime; kind: "config" | "oracle" | "vaultX" | "vaultY" }
  >();
  private readonly startedAt = Date.now();
  private currentSlot = 0;

  constructor(
    readonly pools: PoolRuntime[],
    private readonly executor: PauseExecutor,
    private readonly alerts: AlertSink,
    private readonly opts: EngineOptions,
  ) {
    for (const p of pools) {
      this.byAccount.set(p.configPda, { pool: p, kind: "config" });
      this.byAccount.set(p.oraclePda, { pool: p, kind: "oracle" });
      this.byAccount.set(p.vaultX, { pool: p, kind: "vaultX" });
      this.byAccount.set(p.vaultY, { pool: p, kind: "vaultY" });
    }
  }

  /** All pubkeys the account subscription must cover (pool accounts + onchain refs). */
  subscribedAccounts(): string[] {
    const keys = new Set<string>(this.byAccount.keys());
    for (const p of this.pools) for (const k of p.onchainRefs.keys()) keys.add(k);
    return [...keys];
  }

  txWatchAccounts(): string[] {
    return this.pools.flatMap((p) => [p.configPda, p.oraclePda]);
  }

  onSlot(slot: number): void {
    if (slot > this.currentSlot) this.currentSlot = slot;
  }

  /**
   * The stream was blind for a while (disconnect, failover, slot gap).
   * Reconcile re-reads account state but cannot replay the transactions we
   * missed, so a deposit or withdrawal during the gap would look like a
   * drain. Drop the drawdown history and rebuild from the current state.
   */
  onStreamDiscontinuity(reason: string): void {
    const now = Date.now();
    for (const pool of this.pools) {
      resetWindow(pool.drawdown);
      pool.lastBalances = null;
      pool.persist.delete("drawdown");
      pool.lpSettleUntil = Math.max(pool.lpSettleUntil, now + LP_SETTLE_MS);
    }
    this.alerts.info(
      `code=stream-gap ${reason} — drawdown baselines reset (missed transactions cannot be replayed)`,
    );
  }

  onAccountUpdate(pubkey: string, data: Uint8Array, slot: number, source: string): void {
    // onchain reference accounts (may belong to several pools)
    for (const p of this.pools) {
      const ref = p.onchainRefs.get(pubkey);
      if (ref) ref.update(data, Date.now());
    }
    const entry = this.byAccount.get(pubkey);
    if (!entry) return;
    const { pool, kind } = entry;
    // Drop anything older than what we already applied. Every caller supplies
    // a real slot (reconcile carries the RPC read's context slot), so a
    // lagging read can never overwrite fresher stream state.
    const last = pool.accountSlots.get(pubkey) ?? 0;
    if (slot < last) return;
    pool.accountSlots.set(pubkey, slot);

    try {
      switch (kind) {
        case "config": {
          const next = decodeConfigSnapshot(data);
          const prev = pool.config;
          pool.config = next;
          if (prev) this.diffAndClassify(pool, configChanges(prev, next, slot));
          break;
        }
        case "oracle": {
          const next = decodeOracleSnapshot(data);
          const prev = pool.oracle;
          pool.oracle = next;
          if (prev && prev.authority !== next.authority) {
            this.diffAndClassify(pool, [
              { field: "oracleAuthority", oldValue: prev.authority, newValue: next.authority, slot },
            ]);
          }
          break;
        }
        case "vaultX":
          pool.baseAtoms = decodeTokenAmount(data);
          break;
        case "vaultY":
          pool.quoteAtoms = decodeTokenAmount(data);
          break;
      }
    } catch (err) {
      console.error(`[engine] decode failed pool=${pool.name} kind=${kind} source=${source}:`, err);
    }
  }

  onIxEvents(events: HadronIxEvent[]): void {
    for (const ev of events) {
      for (const p of this.pools) {
        if (ev.accounts.includes(p.configPda) || ev.accounts.includes(p.oraclePda)) {
          p.recentIxs.push(ev);
          if (p.recentIxs.length > 50) p.recentIxs.shift();
          if (ev.lp) this.onLiquidityFlow(p, ev);
        }
      }
    }
  }

  /**
   * A deposit or withdrawal moves the pool's equity without anyone losing
   * value, so it must not read as drawdown. Shift the budget's baseline by
   * the equity the flow added or removed — measured at the current reference
   * price, the same price the budget marks with.
   */
  private onLiquidityFlow(pool: PoolRuntime, ev: HadronIxEvent): void {
    const lp = ev.lp!;
    const now = Date.now();
    pool.lpSettleUntil = now + LP_SETTLE_MS;

    const agg = aggregateRefs(pool.refSources, now, pool.cfg.refQuorum, pool.cfg.refMaxDispersionBps);
    const sign = lp.isDeposit ? 1 : -1;
    const dBaseUi = (sign * Number(lp.xAmount)) / 10 ** pool.decBase;
    const dQuoteUi = (sign * Number(lp.yAmount)) / 10 ** pool.decQuote;

    if (agg.mid != null && agg.quality === "ok" && agg.mid > 0) {
      applyLiquidityFlow(
        pool.drawdown,
        dBaseUi + dQuoteUi / agg.mid,
        dQuoteUi + dBaseUi * agg.mid,
      );
    } else {
      // Can't value the flow — drop history rather than risk a false pause.
      resetWindow(pool.drawdown);
    }
    // The flow invalidates any in-flight persistence for the budget.
    pool.persist.delete("drawdown");
    this.alerts.info(
      `pool=${pool.name} code=lp-flow ${lp.isDeposit ? "deposit" : "withdrawal"} ` +
        `x=${lp.xAmount} y=${lp.yAmount} sig=${ev.signature} — drawdown baseline adjusted`,
    );
  }

  /** Discrete (event) verdicts act immediately; no persistence needed. */
  private diffAndClassify(
    pool: PoolRuntime,
    changes: FieldChange[],
    opts?: { downtime?: boolean },
  ): void {
    if (changes.length === 0) return;
    const ctx: AuthorityCtx = {
      poolName: pool.name,
      pauserPubkey: this.executor.pauserPubkey.toBase58(),
      pauseOnChange: pool.cfg.detectors.quoteAuthority.pauseOnChange,
      expectedQuotingAuthorities: pool.expectedQuoting,
    };
    for (const change of changes) {
      const verdict = classifyFieldChange(change, ctx);
      if (!verdict) continue;
      const v = opts?.downtime
        ? { ...verdict, message: `${verdict.message} (changed while watchdog was DOWN)` }
        : verdict;
      this.handleVerdict(pool, v, { persisted: true, discrete: true });
    }
  }

  /**
   * Restore restart memory: the drawdown windows resume (deploys stop
   * re-arming the budget) and the stored authority baseline is diffed against
   * current chain state, so a rotation that landed while the process was down
   * classifies exactly like a live one — pause-tier included.
   */
  restoreSnapshot(snap: PauserSnapshot | null): void {
    if (!snap?.pools) return;
    for (const pool of this.pools) {
      const s = snap.pools[pool.configPda];
      if (!s) continue;
      if (Array.isArray(s.window)) {
        pool.drawdown.window = s.window.filter(
          (w) => typeof w?.ts === "number" && typeof w?.eBase === "number" && typeof w?.eQuote === "number",
        );
      }
      if (s.pausedByUsSig) pool.pausedByUsSig = s.pausedByUsSig;
      if (s.fields && pool.config && pool.oracle) {
        const current = baselineFields(pool.config, pool.oracle.authority);
        this.diffAndClassify(pool, diffBaseline(s.fields, current), { downtime: true });
      }
    }
  }

  buildSnapshot(): PauserSnapshot {
    const pools: PauserSnapshot["pools"] = {};
    for (const p of this.pools) {
      pools[p.configPda] = {
        window: downsampleWindow(p.drawdown.window),
        fields: p.config && p.oracle ? baselineFields(p.config, p.oracle.authority) : undefined,
        pausedByUsSig: p.pausedByUsSig ?? undefined,
      };
    }
    return { version: SNAPSHOT_VERSION, savedAt: Date.now(), pools };
  }

  /** One evaluation pass per pool. Call on an interval (tickMs). */
  tick(): void {
    const now = Date.now();
    for (const pool of this.pools) {
      try {
        this.tickPool(pool, now);
      } catch (err) {
        console.error(`[engine] tick failed pool=${pool.name}:`, err);
      }
    }
  }

  private tickPool(pool: PoolRuntime, now: number): void {
    const agg = aggregateRefs(
      pool.refSources,
      now,
      pool.cfg.refQuorum,
      pool.cfg.refMaxDispersionBps,
    );
    const cfg = pool.config;
    const oracle = pool.oracle;
    const pushedUi =
      oracle && oracle.midAtomRatio > 0
        ? atomRatioToUi(oracle.midAtomRatio, pool.decBase, pool.decQuote)
        : null;

    const det = pool.cfg.detectors;
    const pauseVerdicts: Verdict[] = [];
    const alertVerdicts: Verdict[] = [];
    /** codes firing this tick, including ones downgraded to alert-only —
     *  so episode resolution works regardless of whether they can pause */
    const firingCodes = new Set<string>();
    let metrics: Record<string, unknown> = {};

    if (det.midDeviation.enabled) {
      const r = evalMidDeviation(
        { pushedUi, refMid: agg.mid, refOk: agg.quality === "ok" },
        det.midDeviation,
      );
      metrics = { ...metrics, ...r.metrics };
      for (const v of r.verdicts) (v.level === "pause" ? pauseVerdicts : alertVerdicts).push(v);
    }

    const ready =
      cfg != null && pool.baseAtoms != null && pool.quoteAtoms != null && cfg.state !== 4;

    // Balance discontinuity: tokens left the pool faster than trading explains.
    // Hold drawdown pauses until a transaction accounts for it (or doesn't).
    if (pool.baseAtoms != null && pool.quoteAtoms != null) {
      const prev = pool.lastBalances;
      if (prev) {
        const dropped = (before: bigint, after: bigint) =>
          before > 0n && after < before &&
          Number(before - after) / Number(before) > BALANCE_JUMP_FRACTION;
        if (dropped(prev.base, pool.baseAtoms) || dropped(prev.quote, pool.quoteAtoms)) {
          pool.lpSettleUntil = Math.max(pool.lpSettleUntil, now + LP_SETTLE_MS);
          pool.persist.delete("drawdown");
          this.alerts.info(
            `pool=${pool.name} code=balance-jump vault balances moved sharply in one tick ` +
              `(base ${prev.base}->${pool.baseAtoms}, quote ${prev.quote}->${pool.quoteAtoms}) — ` +
              `holding drawdown verdicts while it is explained`,
          );
        }
      }
      pool.lastBalances = { base: pool.baseAtoms, quote: pool.quoteAtoms };
    }

    if (ready && det.drawdown.enabled) {
      const baseAtoms = Number(pool.baseAtoms);
      const quoteAtoms = Number(pool.quoteAtoms);
      const r = evalDrawdown(
        pool.drawdown,
        {
          now,
          baseUi: baseAtoms / 10 ** pool.decBase,
          quoteUi: quoteAtoms / 10 ** pool.decQuote,
          refMid: agg.mid,
          refOk: agg.quality === "ok",
          pushedAtomMid: oracle?.midAtomRatio ?? null,
          baseAtoms,
          quoteAtoms,
          onchain: {
            enabled: cfg.thresholdBps > 0 && cfg.rotationIntervalSlots > 0,
            thresholdBps: cfg.thresholdBps,
            hwmBase: Number(cfg.hwmBaseCurrent) / 2 ** 32,
            hwmBasePrev: Number(cfg.hwmBasePrevious) / 2 ** 32,
            hwmQuote: Number(cfg.hwmQuoteCurrent) / 2 ** 32,
            hwmQuotePrev: Number(cfg.hwmQuotePrevious) / 2 ** 32,
          },
        },
        det.drawdown,
      );
      metrics = { ...metrics, ...r.metrics };
      const settling = now < pool.lpSettleUntil;
      for (const v of r.verdicts) {
        if (v.level !== "pause") {
          alertVerdicts.push(v);
        } else if (settling) {
          // Reading is untrustworthy: the vault update and the transaction
          // explaining it can arrive out of order.
          firingCodes.add(v.code);
          alertVerdicts.push({
            ...v,
            level: "alert",
            severity: "warning",
            message: `${v.message} — held, settling after a liquidity event`,
          });
        } else if (!det.drawdown.pauseOnBreach) {
          // Alert-only by default: a false pause costs more than a late one.
          firingCodes.add(v.code);
          alertVerdicts.push({
            ...v,
            level: "alert",
            severity: "critical",
            message: `${v.message} — alert only (drawdown.pauseOnBreach is false)`,
          });
        } else {
          pauseVerdicts.push(v);
        }
      }
    }

    for (const v of alertVerdicts) this.handleVerdict(pool, v, { persisted: true, discrete: false });

    for (const code of PAUSE_CODES) {
      const firing = pauseVerdicts.find((v) => v.code === code);
      const ring = pool.persist.get(code) ?? [];
      ring.push(Boolean(firing));
      while (ring.length > WINDOW_TICKS) ring.shift();
      pool.persist.set(code, ring);
      const persisted = ring.filter(Boolean).length >= PERSIST_TICKS;
      if (firing) {
        firingCodes.add(code);
        this.handleVerdict(pool, firing, { persisted, discrete: false });
      }
    }

    // close episodes that stopped firing
    for (const [code, ep] of pool.episodes) {
      if ((PAUSE_CODES as readonly string[]).includes(code) && !firingCodes.has(code)) {
        pool.episodes.delete(code);
        this.alerts.info(`:white_check_mark: [${pool.name}] ${code} resolved (active ${Math.round((now - ep.since) / 1000)}s)`);
      }
    }

    pool.lastMetrics = {
      state: cfg ? POOL_STATE_NAMES[cfg.state] ?? cfg.state : "unknown",
      mode: pool.cfg.mode,
      armedEffective: this.effectiveArmed(pool),
      refQuality: agg.quality,
      refReason: agg.reason,
      refMid: agg.mid,
      pushedMidUi: pushedUi,
      oracleLastUpdateSlot: oracle?.lastUpdateSlot ?? null,
      currentSlot: this.currentSlot,
      ...metrics,
      pauseAttempts: pool.pauseAttempts,
      pausedByUsSig: pool.pausedByUsSig,
    };
  }

  private effectiveArmed(pool: PoolRuntime): boolean {
    if (pool.cfg.mode !== "armed") return false;
    const onchainPauser = pool.config?.pauseAuthority;
    return onchainPauser === this.executor.pauserPubkey.toBase58();
  }

  private handleVerdict(
    pool: PoolRuntime,
    verdict: Verdict,
    flags: { persisted: boolean; discrete: boolean },
  ): void {
    const now = Date.now();
    const reAlertMs = this.opts.reAlertMs ?? 600_000;
    const ep = pool.episodes.get(verdict.code);
    const isNewEpisode = !ep;
    const shouldAlert = isNewEpisode || now - ep.lastAlertAt >= reAlertMs;

    const inWarmup = now - this.startedAt < this.opts.warmupMs;
    const armed = this.effectiveArmed(pool);
    // Warmup gates the statistical detectors (their baselines are seeding);
    // discrete authority facts need no seeding, so they may pause during
    // warmup — otherwise a rotation discovered at boot would alert once and
    // never act.
    const live =
      verdict.level === "pause" &&
      flags.persisted &&
      armed &&
      !this.opts.dryRun &&
      (flags.discrete || !inWarmup);

    if (shouldAlert) {
      pool.episodes.set(verdict.code, { since: ep?.since ?? now, lastAlertAt: now });
      const prefix =
        verdict.level !== "pause"
          ? undefined
          : live
            ? "PAUSING —"
            : `[${this.opts.dryRun ? "DRY_RUN" : !flags.discrete && inWarmup ? "WARMUP" : pool.cfg.mode === "armed" ? "NOT-AUTHORIZED" : "SHADOW"}] WOULD PAUSE —`;
      this.alerts.send(pool.name, verdict, prefix ? { prefix } : undefined);
    }

    if (verdict.level !== "pause" || !flags.persisted) return;
    if (!live) return;
    void this.executePause(pool, verdict);
  }

  private async executePause(pool: PoolRuntime, verdict: Verdict): Promise<void> {
    const now = Date.now();
    if (pool.pauseInFlight) return;
    if (now - pool.lastPauseAttemptAt < this.opts.pauseCooldownMs) return;
    const state = pool.config?.state;
    if (state !== 1 && state !== 3) return; // nothing to do (already 2/4)

    pool.pauseInFlight = true;
    pool.lastPauseAttemptAt = now;
    pool.pauseAttempts += 1;
    try {
      const result = await this.executor.pause(
        new PublicKey(pool.configPda),
        new PublicKey(pool.curveMeta),
      );
      const base = `pause attempt #${pool.pauseAttempts} (${verdict.code}): ${result.outcome}`;
      if (result.outcome === "paused") {
        pool.pausedByUsSig = result.signature ?? null;
        this.alerts.send(pool.name, {
          detector: "engine",
          code: "paused",
          level: "alert",
          severity: "critical",
          message: `POOL PAUSED by watchdog — ${verdict.message} (sig ${result.signature})`,
          evidence: { trigger: verdict.code, ...verdict.evidence },
        });
      } else if (result.outcome === "already-paused" || result.outcome === "pool-closed") {
        this.alerts.info(`:white_check_mark: [${pool.name}] ${base} — ${result.detail}`);
      } else if (result.outcome === "unauthorized") {
        this.alerts.send(pool.name, {
          detector: "engine",
          code: "pause-unauthorized",
          level: "alert",
          severity: "critical",
          message: `pause tx UNAUTHORIZED — our key is no longer the pause authority (${base})`,
          evidence: { detail: result.detail },
        });
      } else {
        this.alerts.send(pool.name, {
          detector: "engine",
          code: "pause-failed",
          level: "alert",
          severity: "high",
          message: `pause attempt FAILED (${result.detail}) — will retry after cooldown while the condition persists`,
          evidence: { trigger: verdict.code, signature: result.signature ?? null },
        });
      }
    } catch (err) {
      this.alerts.send(pool.name, {
        detector: "engine",
        code: "pause-error",
        level: "alert",
        severity: "high",
        message: `pause attempt threw: ${(err as Error).message}`,
        evidence: { trigger: verdict.code },
      });
    } finally {
      pool.pauseInFlight = false;
    }
  }

  metricsSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = { currentSlot: this.currentSlot };
    for (const p of this.pools) out[p.name] = p.lastMetrics;
    return out;
  }
}

function configChanges(prev: ConfigSnapshot, next: ConfigSnapshot, slot: number): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of WATCHED_CONFIG_FIELDS) {
    const oldValue = String(prev[field]);
    const newValue = String(next[field]);
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue, slot });
  }
  return changes;
}
