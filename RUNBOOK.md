# hadron-pauser runbook

## The watchdog paused a pool

The `[alert]` log line carries the trigger code and an evidence bundle
(detector inputs, thresholds, ref snapshots). Do these in order:

1. **Verify the trigger.** Compare the pool's pushed mid and recent fills
   against the evidence bundle's reference prices. `quoting-auth-rotated`:
   check who signed `RotateQuotingAuthority` (disc 35 — it is admin-signed,
   so an unexpected one implies ADMIN compromise, see COVERAGE.md).
   `mid-deviation`: confirm the reference sources are healthy and the pushed
   mid really is off-market (the evidence carries both numbers).
   `drawdown`: confirm vault balances and the reference marks; a real drain
   shows one-sided vault outflow at off-market prices, while a pure market
   move shows price change with balanced flow (the budget is an MTM
   stop-loss — a big benign move can consume it; that pause is still
   protective, just not theft).
2. **If compromise is confirmed — rotate the quoting authority FIRST**
   (`RotateQuotingAuthority`, disc 35, admin-signed). Pausing does NOT stop
   the feed: a compromised quoter can keep pushing prices while Paused, and
   an unpause against poisoned marks re-opens the drain.
3. **Re-anchor the drawdown guard** (`UpdateDrawdownGuard`, disc 30,
   admin-signed) — while the pool is not `Initialized` it re-anchors the HWMs
   at the current oracle mid, so the guard doesn't instantly re-trip on
   stale baselines.
4. **Unpause** (`SetPoolState` to `Initialized`, disc 21, admin-signed —
   the watchdog *cannot* do this).
5. **Re-arm.** If the pauser condition is still failing, the watchdog will
   pause again after its cooldown — that is by design (it only re-pauses
   while the world is still on fire). Clear or re-threshold the detector if
   the re-fire is a false positive.

## Alert triage (no pause)

- `pauser-rotated-away` — the admin moved the pause authority off this
  watchdog. If that wasn't you, treat as admin compromise.
- `delta-staleness-changed` → 0 — the staleness gate was disabled. This is
  signed by the QUOTING authority and is the classic compromise opening
  move. Verify with the quoting operator immediately.
- `guard-threshold-changed (WEAKENED)` / `guard-interval-changed` — admin
  action; confirm it was intended.
- `pool-unpaused` — admin resumed the pool. Expected during incident
  recovery; unexpected otherwise.
- `mid-deviation-nearing` — the pushed mid is at ≥60% of the deviation limit.
  Check the ref sources first (is one of them the problem?), then the pool's
  quoting.
- `drawdown-nearing` — equity is at ≥60% (high) / ≥90% (critical) of the
  drawdown budget at reference marks. Early warning for a slow drain or a
  sustained adverse market move: check `drawdownBps` / `midDeviationBps` in
  `/health` and recent flow before it becomes a pause.
- `guard-headroom` — the ON-CHAIN guard is >60% consumed at pushed-mid
  marks. Not an attack by itself (benign drift can do this on quiet pools —
  evaluation is lazy), but check `drawdownBps` at reference marks alongside it.
- `lp-flow` — a deposit or withdrawal was seen and the drawdown baseline was
  adjusted for it. Informational; expected whenever liquidity moves. If you
  see one you did not initiate, check who signed it (deposit and withdraw
  authorities are separate keys from the quoting authority).
- `balance-jump` — vault balances moved sharply in one tick and drawdown
  verdicts are held while it is explained. Normal around liquidity events and
  large trades; if it is followed by a `drawdown` pause, nothing explained it.
- `stream-gap` — the stream was blind (disconnect or failover) and drawdown
  baselines were reset, because transactions missed during a gap cannot be
  replayed. Expected after a reconnect.
- `ref-degraded` — the watchdog is partially blind; price detectors are
  alert-only until the reference recovers. Fix the feed, don't restart the
  container.
- `pause-unauthorized` — a pause was attempted but our key is no longer the
  pause authority. The watchdog is disarmed; page the pool admin.

## Benign startup lines

- `bigint: Failed to load bindings, pure JS will be used` — expected and
  harmless. It comes from a transitive dependency (`@hadron-fi/sdk-v2` →
  `@solana/spl-token` → `bigint-buffer`) whose optional native binding isn't
  built for slim/alpine images; it falls back to pure JS and everything the
  pauser does works normally. Nothing in this service uses that code path for
  anything but library-internal math.
- `WARN pool …: ON-CHAIN drawdown guard is disabled (threshold=0bps …)` —
  informational: that pool has no on-chain guard configured, so this
  watchdog's drawdown budget is its only drawdown protection.
- `no snapshot at … — fresh start` — normal on a first boot or after
  changing the snapshot location.

## Alerts

Every verdict is one structured stdout line — severity, pool, code, message,
and the full evidence bundle:

```
[alert] severity=critical pool=my-pool code=mid-deviation [SHADOW] WOULD PAUSE — \
  pushed mid 84.2bps off the independent reference (limit 60bps) \
  evidence={"midDeviationBps":84.2,"pushedUi":...,"refMid":...}
```

The service holds no notification credential of its own. Route these wherever
you already page: on ECS the logs land in CloudWatch, so a metric filter on
`[alert]` (or on `severity=critical`, or a specific `code=`) plus an alarm is
the whole integration. `npm run dev` prints them to your terminal.

## State and restarts

Everything re-derives from chain at boot except two things, carried by an
optional but recommended snapshot: `STATE_S3_BUCKET` (the Terraform module
provisions the bucket and scoped task role automatically) or `STATE_PATH` for
a local volume. Written every 60s and on shutdown.

1. **The drawdown window** — without it, every restart or deploy re-arms the
   budget from zero over `windowMs`.
2. **The authority baseline** — at boot it diffs the stored values against
   chain, so a rotation that happened *while the process was down* is detected
   and classified exactly like a live one.

With neither set the service runs stateless, which is safe; the only cost is
the drawdown budget re-arming.

## Health

`/health` (port 8080, or `HEALTH_PORT`) reports **process alive + chain stream
fresh** — never "has it paused recently", and never pool state. A watchdog
that has paused nothing in months is healthy; a paused pool is a metric, not
an outage. A degraded reference alerts but does not fail the health check,
because restarting a container cannot fix someone else's price feed.

## Service ops

- Health: `GET :8080/health` — `checks.grpc_connected`, `checks.stream_fresh`,
  per-pool metrics (state, refQuality, midDeviationBps, drawdownBps,
  drawdownPct, headroomPct, pauseAttempts).
- `npm run check` — offline-ish preflight: decodes every configured pool,
  verifies `pause_authority` vs our key, probes refs, prints balances.
- Logs: every verdict edge is one `[alert]` line with the evidence JSON.
- The pauser key needs SOL for fees (alerts below `minSignerSol`).
- Restarts: everything re-derives from chain at boot, and with a snapshot
  store configured (STATE_S3_BUCKET / STATE_PATH) the drawdown window resumes
  and authority changes that landed during downtime are detected and
  classified (look for "(changed while watchdog was DOWN)" alerts right
  after boot). Without a store, the drawdown budget re-arms from empty over
  `windowMs`; mid-deviation and pinned authority checks are unaffected.
