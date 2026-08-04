import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { AlertSink } from "./alerts.js";
import {
  CONFIG_SIZE,
  POOL_STATE_NAMES,
  decodeConfigSnapshot,
  decodeMintDecimals,
  decodeOracleSnapshot,
  decodeTokenAmount,
  deriveOraclePda,
  deriveVaults,
  resolveProgramId,
} from "./chain/accounts.js";
import { PauseExecutor } from "./chain/pause.js";
import { RpcPool } from "./chain/rpc.js";
import { loadPauserKeypair } from "./chain/signer.js";
import { extractHadronIxs } from "./chain/txs.js";
import { AppConfig, PoolConfig, loadConfig } from "./config.js";
import { Engine, PoolRuntime, initPoolRuntime } from "./engine/engine.js";
import { OnchainAccountRef, buildRefSource } from "./refs/index.js";
import { storeFromEnv } from "./state/store.js";
import { atomRatioToUi, bpsBetween, shortKey } from "./util.js";
import { initObservability } from "./vendor/observability/index.js";
import { GrpcStreamManager, buildSubscribeRequest } from "./vendor/stream/index.js";

async function bootstrapPools(
  cfg: AppConfig,
  rpc: RpcPool,
  programId: PublicKey,
  onWarn: (msg: string) => void,
): Promise<PoolRuntime[]> {
  const configPdas = cfg.pools.map((p) => new PublicKey(p.config));
  const configDatas = await rpc.fetchAccounts(configPdas);

  const runtimes: PoolRuntime[] = [];
  for (let i = 0; i < cfg.pools.length; i++) {
    const poolCfg: PoolConfig = cfg.pools[i];
    const data = configDatas[i];
    if (!data) throw new Error(`pool ${poolCfg.name}: config account ${poolCfg.config} not found`);
    if (data.length !== CONFIG_SIZE) {
      throw new Error(
        `pool ${poolCfg.name}: config account is ${data.length}B, expected ${CONFIG_SIZE}B — wrong account or wrong program version`,
      );
    }
    const snapshot = decodeConfigSnapshot(Uint8Array.from(data));
    const configPda = configPdas[i];
    const oraclePda = deriveOraclePda(snapshot, programId);
    const { vaultX, vaultY } = deriveVaults(configPda, snapshot);

    const [oracleData, vaultXData, vaultYData, mintXData, mintYData] = await rpc.fetchAccounts([
      oraclePda,
      vaultX,
      vaultY,
      new PublicKey(snapshot.mintX),
      new PublicKey(snapshot.mintY),
    ]);
    if (!oracleData) throw new Error(`pool ${poolCfg.name}: midprice oracle ${oraclePda.toBase58()} not found`);
    if (!mintXData || !mintYData) throw new Error(`pool ${poolCfg.name}: mint account missing`);
    const oracle = decodeOracleSnapshot(Uint8Array.from(oracleData));
    const decBase = decodeMintDecimals(Uint8Array.from(mintXData));
    const decQuote = decodeMintDecimals(Uint8Array.from(mintYData));

    const refSources = poolCfg.refs.map((r) =>
      buildRefSource(r, (source, err) =>
        console.error(`[refs] ${poolCfg.name}/${source}:`, (err as Error)?.message ?? err),
      ),
    );
    const onchainRefs = new Map<string, OnchainAccountRef>();
    for (const src of refSources) {
      if (src instanceof OnchainAccountRef) {
        src.setDecimals(decBase, decQuote);
        onchainRefs.set(src.account, src);
      }
    }

    const expectedQuoting = new Set(
      poolCfg.detectors.quoteAuthority.expected ?? [oracle.authority],
    );
    if (poolCfg.mode === "armed" && !poolCfg.detectors.quoteAuthority.expected) {
      onWarn(
        `pool ${poolCfg.name}: armed without pinned quoteAuthority.expected — the allowlist falls back to the boot-observed quoter; pin it in config (a snapshot store covers downtime rotations, pinning covers everything)`,
      );
    }

    const runtime = initPoolRuntime({
      cfg: poolCfg,
      name: poolCfg.name,
      configPda: configPda.toBase58(),
      oraclePda: oraclePda.toBase58(),
      vaultX: vaultX.toBase58(),
      vaultY: vaultY.toBase58(),
      curveMeta: snapshot.curveMeta,
      decBase,
      decQuote,
      refSources,
      onchainRefs,
      expectedQuoting,
    });
    runtime.config = snapshot;
    runtime.oracle = oracle;
    runtime.baseAtoms = vaultXData ? decodeTokenAmount(Uint8Array.from(vaultXData)) : 0n;
    runtime.quoteAtoms = vaultYData ? decodeTokenAmount(Uint8Array.from(vaultYData)) : 0n;
    runtimes.push(runtime);

    const stateName = POOL_STATE_NAMES[snapshot.state] ?? String(snapshot.state);
    if (snapshot.state !== 1) onWarn(`pool ${poolCfg.name}: boot state is ${stateName}`);
    if (!(snapshot.thresholdBps > 0 && snapshot.rotationIntervalSlots > 0)) {
      onWarn(`pool ${poolCfg.name}: ON-CHAIN drawdown guard is disabled (threshold=${snapshot.thresholdBps}bps interval=${snapshot.rotationIntervalSlots})`);
    }
  }
  return runtimes;
}

function printCheckTable(pools: PoolRuntime[], pauserPubkey: string): boolean {
  let ok = true;
  for (const p of pools) {
    const c = p.config!;
    const authorized = c.pauseAuthority === pauserPubkey;
    if (!authorized && p.cfg.mode === "armed") ok = false;
    console.log(
      [
        `pool ${p.name} (${shortKey(p.configPda)})`,
        `  state:            ${POOL_STATE_NAMES[c.state] ?? c.state}`,
        `  mode:             ${p.cfg.mode}${p.cfg.mode === "armed" && !authorized ? "  << NOT AUTHORIZED, will run shadow" : ""}`,
        `  pause_authority:  ${c.pauseAuthority} ${authorized ? "(this watchdog ✓)" : "(NOT this watchdog ✗)"}`,
        `  quoting auth:     ${p.oracle?.authority}`,
        `  admin:            ${c.authority}`,
        `  withdraw auth:    ${c.withdrawAuthority}`,
        `  delta_staleness:  ${c.deltaStaleness} slots${c.deltaStaleness === 0 ? "  << staleness gate DISABLED" : ""}`,
        `  on-chain guard:   ${c.thresholdBps}bps / ${c.rotationIntervalSlots} slots`,
        `  detectors:        mid-deviation ${p.cfg.detectors.midDeviation.enabled ? `${p.cfg.detectors.midDeviation.maxBps}bps` : "off"} | drawdown ${p.cfg.detectors.drawdown.enabled ? `${p.cfg.detectors.drawdown.maxBps}bps per ${p.cfg.detectors.drawdown.windowMs / 3_600_000}h` : "off"} | quote-auth pause=${p.cfg.detectors.quoteAuthority.pauseOnChange}`,
        `  decimals:         base=${p.decBase} quote=${p.decQuote}`,
        `  pushed mid (ui):  ${p.oracle && p.oracle.midAtomRatio > 0 ? atomRatioToUi(p.oracle.midAtomRatio, p.decBase, p.decQuote) : "n/a"}`,
        `  refs:             ${p.refSources.map((r) => r.name).join(", ")}`,
      ].join("\n"),
    );
  }
  return ok;
}

async function main(): Promise<void> {
  const mode = process.argv[2] === "check" ? "check" : "run";
  const cfg = loadConfig();
  const programId = resolveProgramId(cfg.programId);
  const signer = loadPauserKeypair(cfg.pauserKeypair);
  const rpc = new RpcPool(cfg.rpcUrls);

  console.log(
    `[pauser] starting | cluster=${cfg.cluster} program=${programId.toBase58()} pauser=${signer.publicKey.toBase58()} dryRun=${cfg.dryRun} pools=${cfg.pools.length} mode=${mode}`,
  );

  const warnings: string[] = [];
  const pools = await bootstrapPools(cfg, rpc, programId, (w) => {
    warnings.push(w);
    console.warn(`[pauser] WARN ${w}`);
  });

  if (mode === "check") {
    for (const p of pools) for (const r of p.refSources) r.start();
    await new Promise((r) => setTimeout(r, 6_000));
    const authOk = printCheckTable(pools, signer.publicKey.toBase58());
    for (const p of pools) {
      const pushedUi =
        p.oracle && p.oracle.midAtomRatio > 0
          ? atomRatioToUi(p.oracle.midAtomRatio, p.decBase, p.decQuote)
          : null;
      for (const r of p.refSources) {
        const s = r.latest();
        if (!s) {
          console.log(`  ref ${p.name}/${r.name}: NO DATA (onchain refs fill via stream/reconcile at runtime)`);
        } else {
          // Deviation vs the pushed mid is the unit sanity check: ~10^k off
          // means wrong decimals/scale, ~1/x means a missing invert.
          const dev = pushedUi != null ? bpsBetween(s.price, pushedUi) : null;
          console.log(
            `  ref ${p.name}/${r.name}: ${s.price} (age ${Date.now() - s.ts}ms)${dev != null ? ` — ${dev.toFixed(1)}bps vs pushed mid` : ""}`,
          );
        }
        r.stop();
      }
    }
    const balance = await rpc.fetchBalanceSol(signer.publicKey).catch(() => null);
    console.log(`  pauser SOL balance: ${balance ?? "unknown"}`);
    if (!authOk) {
      console.error("check FAILED: an armed pool does not have this watchdog as pause_authority");
      process.exit(1);
    }
    console.log("check OK");
    process.exit(0);
  }

  // ---- run mode -----------------------------------------------------------
  let shuttingDown = false;
  const obs = initObservability({
    service: "hadron-pauser",
    cluster: cfg.cluster,
    health: {
      port: cfg.healthPort,
      livenessChecks: [{ name: "grpc_connected", reasonWhenDown: "grpc_disconnected" }],
      freshness: [{ name: "stream", staleMs: cfg.streamStaleMs }],
      getMetrics: () => ({
        dryRun: cfg.dryRun,
        pauser: signer.publicKey.toBase58(),
        warnings,
        ...engine.metricsSnapshot(),
      }),
    },
    heartbeatUrl: cfg.heartbeatUrl,
    getIsShuttingDown: () => shuttingDown,
  });

  const alerts = new AlertSink();
  const executor = new PauseExecutor(rpc, signer, programId, {
    cuPriceMicroLamports: cfg.cuPriceMicroLamports,
  });
  const engine = new Engine(pools, executor, alerts, {
    dryRun: cfg.dryRun,
    warmupMs: cfg.warmupMs,
    pauseCooldownMs: cfg.pauseCooldownMs,
  });

  // Restart memory (drawdown windows + downtime authority diffs). Optional:
  // no store configured => fresh start, which only re-arms the budget.
  const store = storeFromEnv();
  if (store) {
    const snap = await store.load().catch((err) => {
      obs.health.recordBroken("state", "load", err);
      return null;
    });
    if (snap) {
      engine.restoreSnapshot(snap);
      console.log(
        `[pauser] restored snapshot from ${store.describe()} (age ${Math.round((Date.now() - snap.savedAt) / 1000)}s)`,
      );
    } else {
      console.log(`[pauser] no snapshot at ${store.describe()} — fresh start`);
    }
  } else {
    console.log("[pauser] state persistence disabled (set STATE_S3_BUCKET or STATE_PATH)");
  }
  let saveInFlight = false;
  const saveSnapshot = async () => {
    if (!store || saveInFlight) return;
    saveInFlight = true;
    try {
      await store.save(engine.buildSnapshot());
    } catch (err) {
      obs.health.recordBroken("state", "save", err);
    } finally {
      saveInFlight = false;
    }
  };
  const snapshotTimer = store
    ? setInterval(() => void saveSnapshot(), Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000))
    : null;

  for (const p of pools) for (const r of p.refSources) r.start();

  const programId58 = programId.toBase58();
  const grpc = new GrpcStreamManager(
    {
      endpoints: [
        { endpoint: cfg.grpc.endpoint, token: cfg.grpc.token, label: "primary" },
        ...(cfg.grpc.backupEndpoint
          ? [{ endpoint: cfg.grpc.backupEndpoint, token: cfg.grpc.backupToken, label: "backup" }]
          : []),
      ],
      keepalive: cfg.grpc.keepalive,
    },
    {
      buildRequest: () =>
        buildSubscribeRequest({
          commitment: "confirmed",
          accounts: { watch: { account: engine.subscribedAccounts() } },
          transactions: {
            hadron: { accountInclude: engine.txWatchAccounts(), vote: false, failed: false },
          },
          slots: true,
        }),
      onData: (data: any) => {
        obs.health.markFresh("stream");
        try {
          if (data?.account?.account) {
            const acc = data.account.account;
            const pubkey =
              typeof acc.pubkey === "string" ? acc.pubkey : bs58.encode(acc.pubkey as Uint8Array);
            engine.onAccountUpdate(
              pubkey,
              acc.data instanceof Uint8Array ? acc.data : Uint8Array.from(acc.data ?? []),
              Number(data.account.slot ?? 0),
              "stream",
            );
          } else if (data?.slot?.slot != null) {
            engine.onSlot(Number(data.slot.slot));
          } else if (data?.transaction) {
            engine.onIxEvents(extractHadronIxs(data, programId58));
          }
        } catch (err) {
          obs.health.recordBroken("stream", "onData", err);
        }
      },
      onConnect: (info) => {
        obs.health.setStatus("grpc_connected", true);
        console.log(
          `[grpc] connected endpoint=${info.endpoint.label} firstConnect=${info.firstConnect} downtimeMs=${info.downtimeMs}`,
        );
        if (!info.firstConnect) {
          engine.onStreamDiscontinuity(`reconnect after ${info.downtimeMs}ms`);
          void reconcile(`reconnect(${info.downtimeMs}ms)`);
        }
      },
      onDisconnect: (reason, err) => {
        obs.health.setStatus("grpc_connected", false);
        obs.health.recordBroken("grpc", reason, err);
      },
      onKeepaliveError: (err) => obs.health.recordBroken("grpc", "keepalive", err),
    },
  );

  const reconcileTargets = engine.subscribedAccounts().map((k) => new PublicKey(k));
  let reconcileInFlight = false;
  async function reconcile(reason: string): Promise<void> {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      // Carry the read's slot: an RPC read often lags the stream, and applying
      // it slotless would let stale bytes overwrite fresher state.
      const reads = await rpc.fetchAccountsWithContext(reconcileTargets);
      for (let i = 0; i < reconcileTargets.length; i++) {
        const { data, slot } = reads[i];
        if (data) {
          engine.onAccountUpdate(
            reconcileTargets[i].toBase58(),
            Uint8Array.from(data),
            slot,
            `reconcile:${reason}`,
          );
        }
      }
    } catch (err) {
      obs.health.recordBroken("rpc", "reconcile", err);
    } finally {
      reconcileInFlight = false;
    }
  }

  await grpc.connect();
  const tickTimer = setInterval(() => engine.tick(), cfg.tickMs);
  const reconcileTimer = setInterval(() => void reconcile("periodic"), cfg.reconcileIntervalMs);

  // ops watcher: pauser key balance + sustained ref degradation
  let lowBalanceAlerted = false;
  const refDegradedSince = new Map<string, number>();
  const watcherTimer = setInterval(async () => {
    try {
      const sol = await rpc.fetchBalanceSol(signer.publicKey);
      if (sol < cfg.minSignerSol && !lowBalanceAlerted) {
        lowBalanceAlerted = true;
        alerts.info(`:rotating_light: pauser key ${shortKey(signer.publicKey.toBase58())} balance ${sol.toFixed(4)} SOL < ${cfg.minSignerSol} — pause txs may fail`);
      } else if (sol >= cfg.minSignerSol) {
        lowBalanceAlerted = false;
      }
    } catch {
      /* balance check is best-effort */
    }
    for (const p of engine.pools) {
      const quality = (p.lastMetrics as { refQuality?: string }).refQuality;
      if (quality && quality !== "ok") {
        const since = refDegradedSince.get(p.name) ?? Date.now();
        refDegradedSince.set(p.name, since);
        if (Date.now() - since > 300_000) {
          alerts.info(
            `pool=${p.name} code=ref-degraded reference degraded for ${Math.round((Date.now() - since) / 60000)}min (${(p.lastMetrics as { refReason?: string }).refReason}) — price detectors are alert-only`,
          );
        }
      } else {
        refDegradedSince.delete(p.name);
      }
    }
  }, 30_000);

  await reconcile("startup");

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[pauser] shutting down");
    clearInterval(tickTimer);
    clearInterval(reconcileTimer);
    clearInterval(watcherTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    void saveSnapshot(); // last write, best-effort within the exit grace
    for (const p of pools) for (const r of p.refSources) r.stop();
    grpc.shutdown();
    obs.stop();
    setTimeout(() => process.exit(0), 1_500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[pauser] running | health :${cfg.healthPort} | watching ${pools.length} pool(s), ${engine.subscribedAccounts().length} accounts`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
