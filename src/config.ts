import { readFileSync } from "node:fs";
import { z } from "zod";
import { expandEnvRef } from "./util.js";

/**
 * Configuration = one JSON document (file or env blob) + env vars for secrets.
 *
 * Delivery paths:
 *  - local/docker: CONFIG_PATH (default ./config.json)
 *  - ECS:          CONFIG_JSON (the whole document as one env var, secrets
 *                  referenced as "env:NAME" — same pattern as hadron-cli's
 *                  PRICE_SOURCE_JSON, so no secret ever lands in tfvars)
 */

const pubkeyStr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 pubkey");

const refSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("binance"),
    /** e.g. "PAXGUSDT" — bookTicker mid ((bid+ask)/2) */
    symbol: z.string(),
    wsBase: z.string().default("wss://stream.binance.com:9443/ws"),
    /** set true when the symbol is quoted the other way around */
    invert: z.boolean().default(false),
    staleMs: z.number().int().positive().default(10_000),
  }),
  z.object({
    kind: z.literal("pyth"),
    /** Hermes hex feed id (0x…) */
    feedId: z.string(),
    url: z.string().default("https://hermes.pyth.network"),
    pollMs: z.number().int().positive().default(2_000),
    invert: z.boolean().default(false),
    staleMs: z.number().int().positive().default(15_000),
  }),
  z.object({
    kind: z.literal("onchain-account"),
    /** raw u64 LE at `offset`, times `scale` (e.g. a venue oracle's mid @424 scale 1e-10) */
    account: pubkeyStr,
    offset: z.number().int().nonnegative(),
    scale: z.number().positive(),
    /** "ui" = quote-per-base UI price; "atomRatio" = quote-atoms per base-atom */
    unit: z.enum(["ui", "atomRatio"]).default("ui"),
    invert: z.boolean().default(false),
    staleMs: z.number().int().positive().default(30_000),
  }),
]);
export type RefSourceConfig = z.infer<typeof refSourceSchema>;

/**
 * Detector surface — deliberately three knobs (simplified 2026-08-04):
 * an expected quoting authority, a max mid deviation, and a drawdown budget.
 * Pre-alerts (60% of a limit, critical at 90%), on-chain guard headroom
 * alerts, and K-of-N tick persistence (3-of-5) are fixed behaviors, not
 * configuration.
 */
const quoteAuthoritySchema = z
  .object({
    /** Unexpected quoting-authority rotation = pause-tier. false → critical alert only. */
    pauseOnChange: z.boolean().default(true),
    /**
     * Quoting authorities considered legitimate. When omitted, the value
     * observed at boot is the allowlist (any change is unexpected).
     */
    expected: z.array(pubkeyStr).optional(),
  })
  .default({});

const midDeviationSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Pause when |pushed mid / reference − 1| reaches this many bps
     * (sustained). The primary detector: any-rate extraction requires
     * off-market quotes, which show here within seconds of the first bad
     * push. Size it ≥ ~3× the pool's normal p99.9 |midDeviationBps|
     * (observable during the shadow soak).
     */
    maxBps: z.number().positive().default(60),
  })
  .default({});

const drawdownSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Whether breaching the budget PAUSES the pool, or only alerts.
     *
     * Defaults to alert-only, deliberately. A false pause stops the pool
     * quoting — real, immediate cost — and this is the detector with by far
     * the widest false-positive surface: it is a mark-to-market measure, so a
     * large genuine market move consumes budget, and it depends on correctly
     * accounting for every deposit and withdrawal. The two detectors that do
     * pause by default (quote-authority change, mid deviation) are
     * high-precision: one is a discrete on-chain fact, the other compares two
     * prices and stands down whenever the reference is degraded.
     *
     * Turn this on once a shadow period has shown you what this budget
     * actually does on your pool's flow.
     */
    pauseOnBreach: z.boolean().default(false),
    /**
     * The drawdown budget: pause when the pool loses this many bps
     * (dual-denomination sum, marked at the REFERENCE price) within
     * windowMs. Note a real drain counts in both denominations (~2× the
     * stolen value) while a pure price move counts ~half its size on a
     * balanced book — this is an MTM stop-loss, so a large benign market
     * move can consume budget too (same semantics as the on-chain guard).
     */
    maxBps: z.number().positive().default(200),
    windowMs: z.number().int().positive().default(64_800_000), // 18h
  })
  .default({});

const poolSchema = z.object({
  name: z.string(),
  /** the pool's Config PDA */
  config: pubkeyStr,
  /** shadow = log/alert WOULD PAUSE only; armed = actually pause (unless global dryRun) */
  mode: z.enum(["shadow", "armed"]).default("shadow"),
  refs: z.array(refSourceSchema).min(1),
  /** minimum fresh ref sources for price-based pause verdicts */
  refQuorum: z.number().int().positive().default(1),
  /** above this max pairwise dispersion the reference is degraded (alert-only) */
  refMaxDispersionBps: z.number().positive().default(50),
  detectors: z
    .object({
      quoteAuthority: quoteAuthoritySchema,
      midDeviation: midDeviationSchema,
      drawdown: drawdownSchema,
    })
    .default({}),
});
export type PoolConfig = z.infer<typeof poolSchema>;

const appSchema = z.object({
  cluster: z.string().default("mainnet-beta"),
  /** first entry is primary; all entries receive pause broadcasts */
  rpcUrls: z.array(z.string()).min(1),
  grpc: z.object({
    endpoint: z.string(),
    token: z.string().optional(),
    backupEndpoint: z.string().optional(),
    backupToken: z.string().optional(),
    keepalive: z.enum(["client-ping", "stream-ping", "none"]).default("stream-ping"),
  }),
  /** "env:PAUSER_SECRET" (bs58 or JSON array) or a keypair file path */
  pauserKeypair: z.string().default("env:PAUSER_SECRET"),
  /** global safety: true = never send, regardless of pool mode */
  dryRun: z.boolean().default(true),
  programId: pubkeyStr.optional(),

  tickMs: z.number().int().positive().default(1_000),
  reconcileIntervalMs: z.number().int().positive().default(60_000),
  /** no pause verdicts until this long after boot (baselines + refs seeding) */
  warmupMs: z.number().int().positive().default(120_000),
  /** min interval between pause attempts per pool */
  pauseCooldownMs: z.number().int().positive().default(30_000),
  cuPriceMicroLamports: z.number().int().nonnegative().default(100_000),

  /** Overridden by the HEALTH_PORT env var when set (the platform owns the port). */
  healthPort: z.number().int().positive().default(8080),
  streamStaleMs: z.number().int().positive().default(90_000),
  heartbeatUrl: z.string().optional(),
  minSignerSol: z.number().nonnegative().default(0.02),

  pools: z.array(poolSchema).min(1),
});
export type AppConfig = z.infer<typeof appSchema>;

export function loadConfig(): AppConfig {
  const blob = process.env.CONFIG_JSON;
  const path = process.env.CONFIG_PATH ?? "config.json";
  let raw: unknown;
  try {
    raw = JSON.parse(blob ?? readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to load config from ${blob ? "CONFIG_JSON env" : path}: ${(err as Error).message}`,
    );
  }
  const parsed = appSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid config:\n${issues}`);
  }
  const cfg = parsed.data;
  // Expand env refs in the fields that may carry secrets.
  cfg.rpcUrls = cfg.rpcUrls.map((u, i) => expandEnvRef(u, `rpcUrls[${i}]`));
  cfg.grpc.endpoint = expandEnvRef(cfg.grpc.endpoint, "grpc.endpoint");
  if (cfg.grpc.token) cfg.grpc.token = expandEnvRef(cfg.grpc.token, "grpc.token");
  if (cfg.grpc.backupEndpoint)
    cfg.grpc.backupEndpoint = expandEnvRef(cfg.grpc.backupEndpoint, "grpc.backupEndpoint");
  if (cfg.grpc.backupToken)
    cfg.grpc.backupToken = expandEnvRef(cfg.grpc.backupToken, "grpc.backupToken");
  if (cfg.heartbeatUrl) cfg.heartbeatUrl = expandEnvRef(cfg.heartbeatUrl, "heartbeatUrl");
  // Deployment-level overrides. The port is owned by the platform (the ECS
  // task definition maps and health-checks a fixed port), so HEALTH_PORT wins
  // over the config document — otherwise a stale healthPort silently fails
  // the container health check and crash-loops the task.
  const envPort = process.env.HEALTH_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`HEALTH_PORT must be a positive integer, got "${envPort}"`);
    }
    cfg.healthPort = parsed;
  }
  const names = new Set<string>();
  for (const p of cfg.pools) {
    if (names.has(p.config)) throw new Error(`duplicate pool config ${p.config}`);
    names.add(p.config);
  }
  return cfg;
}
