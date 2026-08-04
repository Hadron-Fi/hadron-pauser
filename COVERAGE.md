# Coverage model — what this watchdog protects, and what stays with you

Program facts verified against the audited Hadron program source
(`HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8`).

Read this before configuring: it defines what the watchdog is designed to
cover, so you can size your own controls around it. Use alongside the
[disclaimer](./README.md#disclaimer) — this software is provided as-is,
with no warranty.

## The core scenario: compromised quoting authority

The quoting authority pushes the oracle mid that the pool quotes from — and
that the **on-chain drawdown guard uses to value the vaults**. A compromised
quoter can therefore steer the guard's own marks (or bleed to just under its
threshold), can stop calling the guard's poke (the poke is gated to the
quoting authority itself), and can disable the staleness gate
(`UpdateDeltaStaleness` is quoting-authority-signed). The on-chain guard
alone does not contain this attacker.

This watchdog does, because its marks come from reference sources the
attacker doesn't control, and its pause closes the **extraction leg**:
swaps. Extraction requires many fills over time (per-fill size is bounded by
curve depth), and the fast path from first off-market push to frozen swaps is
seconds: gRPC visibility <1s, K-of-N tick persistence, pause tx with a
priority fee landing in 1-2 slots.

Pausing does **not** stop the feed itself — quote pushes never read pool
state. That's fine: with swaps, deposits and withdrawals frozen there is
nothing left to extract. Rotate the quoting key before unpausing (RUNBOOK).

## Coverage table

| Compromised key | Outcome with the watchdog armed |
|---|---|
| **Quoting authority** | **Bounded well.** Off-market quoting shows in the mid-deviation detector within seconds of the first bad push; curve poisoning, staleness-kill and guard-blinding surface via the drawdown budget (reference marks) and the authority/`delta_staleness` diffs; the pause freezes extraction. |
| **Withdraw authority** | **Multi-tx drains bounded.** `Withdraw` moves arbitrary amounts in states `Initialized`/`RejectSwaps`, but `Paused` blocks it — the drawdown budget sees the equity drop and freezes the next withdrawal. A **single-tx 100% withdraw is atomic and cannot be stopped reactively** — keep the withdraw authority cold. |
| **Pause authority (this service's key)** | Worst case: your pool gets paused. It cannot unpause, withdraw, quote, or change anything else. |
| **Pool admin** | **Speed bump only.** The admin can unpause, rotate the pause authority away (you get a `pauser-rotated-away` critical alert), rotate the quoting/withdraw authorities, disable the guard, or `ClosePool` (which sweeps the vaults to the withdraw authority and works even from `Paused`). Admin key custody (multisig/timelock) is the real defense; the watchdog's role there is fast, loud detection. |

## How it detects

Three detectors, three knobs (`detectors`, per pool):

| Detector | Knob(s) | Signal |
|---|---|---|
| **Quote-authority change** | `quoteAuthority.pauseOnChange` (+ `expected` allowlist) | The pool's quoting authority rotates to a key not on your allowlist → pause. Related fields (admin, withdraw/deposit/pause authority, staleness setting, guard params, pool state) always alert. |
| **Mid deviation** | `midDeviation.maxBps` | The pool's pushed mid vs the aggregated independent reference, sustained → pause. The primary detector: extraction at any rate requires quoting off-market, which shows here within seconds of the first bad push. Also catches a frozen mid while the market moves. |
| **Drawdown budget** | `drawdown.maxBps` / `windowMs` / `pauseOnBreach` | Pool equity (both vaults, marked at the **reference** price) may not fall more than `maxBps` below its window maximum within `windowMs` (default 200bps / 18h) → pause. It is a mark-to-market stop-loss, so a large genuine market move consumes budget too. |

### Deposits and withdrawals

Adding or removing liquidity changes the pool's size without anyone losing
value, so it must not read as drawdown. The watchdog watches for `Deposit` and
`Withdraw` instructions on your pool and shifts the budget's baseline by the
equity the flow moved, valued at the same reference price the budget marks
with. A legitimate withdrawal therefore measures as zero drawdown, while
trading losses on either side of it still accumulate normally. (The on-chain
guard solves the same problem by re-anchoring its high-water marks after every
liquidity event.)

The stream delivers the vault write and the transaction that explains it as
independent messages, and the vault write usually arrives first — so the
watchdog does not rely on seeing the transaction in time. Two guards cover it:

- **A sharp one-tick balance move holds drawdown verdicts** for about ten
  seconds while it is explained. Keyed on balances, not equity, so ordinary
  price movement never triggers it. If nothing explains the drop, the hold
  expires and the pause proceeds.
- **A stream gap resets the baseline.** After a disconnect or failover, the
  reconcile sweep re-reads account state but cannot replay the transactions
  it missed, so a liquidity event during the blind period would look like a
  drain. History is dropped and rebuilt from current state instead.

One more consequence worth knowing:
- Because withdrawals are accounted rather than counted as losses, the
  drawdown budget is not what catches a compromised **withdraw** authority.
  `Paused` does block withdrawals, so a pause triggered by any other detector
  still stops one — but treat the withdraw key as something to keep cold
  rather than something this budget watches.

**Which detectors can pause.** Out of the box, only the quote-authority and
mid-deviation detectors pause; the drawdown budget alerts
(`drawdown.pauseOnBreach` defaults to `false`). That is deliberate. A false
pause stops your pool quoting — an immediate, real cost — and the drawdown
budget has by far the widest false-positive surface: it is a mark-to-market
measure, so a large genuine market move consumes budget, and it depends on
correctly accounting for every deposit and withdrawal. The two that do pause
are high-precision: one is a discrete on-chain fact, the other compares two
prices and stands down whenever the reference is degraded. Turn
`pauseOnBreach` on once a shadow period has shown you how the budget behaves
on your pool's flow.

Fixed behavior you do not configure: pre-alerts at 60% of each limit (critical
at 90%), and a pause verdict must persist 3 of the last 5 one-second
evaluations before it acts.

### Reference prices

`refs` per pool, one or more of `pyth` (Hermes feed id), `binance` (bookTicker
symbol), and `onchain-account` (a `u64` at a fixed `offset` × `scale` in
another venue's oracle account). They are aggregated with a robust median plus
staleness, quorum (`refQuorum`) and dispersion (`refMaxDispersionBps`) gates.

If the reference degrades below those gates, the price detectors **downgrade
to alert-only** — the watchdog never pauses on bad data. Choose sources the
pool's quoting authority does not control; never use the pool's own oracle.

Note `binance` is unusable from US IP addresses (HTTP 451), so deploy in a
non-US region if you configure it.

## Design scope

How the system is built to behave, so you can plan your controls around it:

- **Only high-precision signals pause by default.** An unexpected
  quoting-authority rotation and a sustained mid deviation pause the pool; the
  drawdown budget alerts unless you opt it in. Pausing a healthy pool has an
  immediate cost, so the defaults favour the detectors least likely to be
  wrong, and leave the broader one as a human-in-the-loop signal.
- **It is a reactive control.** The watchdog detects and freezes; it does not
  prevent the transactions that precede detection. Value moved inside the
  detection window is not recovered by pausing.
- **Detection follows reference quality.** The price detectors act only on a
  reference that passes the quorum and dispersion gates; below those they
  alert instead of pausing, by design — pausing on bad data would be worse
  than not pausing. Choosing sound, independent reference sources is an
  operator decision.
- **Restart behavior is configurable.** With the snapshot store enabled
  (provisioned by default in the terraform deploy) the drawdown window
  survives restarts and deploys, and authority changes that occur while the
  process is down are detected by the boot baseline diff. Without a store,
  the drawdown budget re-arms over `windowMs` after a restart and the
  boot-observed authority values form the baseline — pin
  `quoteAuthority.expected` for armed pools in either case. The snapshot is
  an input to a safety system, so scope write access to it as you would any
  security control (the terraform deploy scopes it to the task role).
- **Liquidity flow is accounted, not counted as loss.** Deposits and
  withdrawals shift the drawdown baseline rather than consuming budget, so
  normal liquidity operations never trigger a pause. The trade-off is that
  the drawdown budget is not the control that watches the withdraw
  authority; keep that key cold.
- **Price detection needs an external price.** Pools without an independent
  external reference — prediction markets, for example — should run with the
  price detectors disabled; authority detection still applies.

## Your responsibilities as operator

- Custody of the quoting, admin, and withdraw keys (this watchdog protects
  none of them; it reacts to their misuse).
- Reference source selection, threshold configuration, and the shadow-soak
  discipline in the README before arming.
- Keeping the service running, funded, and alerting somewhere a human reads.
- Your own independent monitoring. This tool is one layer, not a substitute
  for the rest of your security program.
