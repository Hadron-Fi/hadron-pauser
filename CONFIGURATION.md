# Configuration

Everything the watchdog does is driven by one JSON document (`config.json` by
default; `CONFIG_PATH` to move it, or `CONFIG_JSON` to pass the whole thing as
an env var, which is how the ECS deploy works). Secrets are never written into
it — reference them as `"env:NAME"`. The authoritative schema with every
default is `src/config.ts` (zod); invalid config fails loudly at boot.

Start from [`config.example.json`](./config.example.json).

## The values you choose

Per pool, these are the decisions. Everything else has a working default.

| Setting | What it is |
|---|---|
| `config` | Your pool's Config PDA (its on-chain address). |
| `refs` | One or more independent price sources. Two is better than one. |
| `quoteAuthority.expected` | The quoting key(s) you consider legitimate. `npm run check` prints the current one. Omit it and whatever key is present at boot becomes the baseline — always pin it before arming. |
| `midDeviation.maxBps` | How far the pool's own mid may drift from that reference before pausing. |
| `drawdown.maxBps` / `windowMs` | How much value the pool may lose within a rolling window before pausing. |
| `refQuorum` / `refMaxDispersionBps` | How many sources must agree, and how far apart they may be before the reference is treated as untrustworthy. |
| `drawdown.pauseOnBreach` | Whether a budget breach pauses or only alerts. Defaults to alert-only. |
| `mode` / `dryRun` | Shadow vs armed. Leave both safe until you have soaked the pool. |

### Starting points

Classify the pair, take the row, then let the shadow period refine it:

| | LST ratio (JitoSOL/SOL) | Major (SOL/USDC) | Stable (USDC/USDT) | RWA, 24/7 (gold) |
|---|---|---|---|---|
| `midDeviation.maxBps` | 20 | 60 | 15 | 80 |
| `drawdown.maxBps` | 120 | 200 | 80 | 300 |
| `drawdown.windowMs` | 18h | 18h | 18h | 18h |
| `refMaxDispersionBps` | 20 | 30 | 10 | 40 |
| `refQuorum` | 1 if that is all that exists | 2 | 2 | 2 |

How to size them yourself:

- **`midDeviation.maxBps`** — normal deviation is cross-venue basis plus feed
  noise plus the pool's own spread. Watch `midDeviationBps` in `/health`
  during the shadow period and set the limit at roughly 3× the worst value
  you actually observe.
- **`drawdown.maxBps`** — a real drain registers in *both* denominations, so
  it counts about twice the value taken; a pure price move registers about
  half its size on a balanced book. Take the worst benign price move you'd
  expect over the window, halve it, then add margin — roughly
  `maxBps ≥ 0.75 × that move`. Volatility grows with the square root of time,
  so a long window buys a tight bound on a patient attacker cheaply.

If your pool has no honest external price source (a prediction market, for
example), disable the two price detectors and run the quote-authority
detector alone.

### A second pool, with two external references

`config.example.json` ships one pool so it runs as-is. Add more to the `pools`
array — here a 24/7 RWA pair using two independent feeds, so `refQuorum: 2`
means neither one alone can trigger or suppress a pause:

```json
{
  "name": "paxg-usdc-example",
  "config": "<your pool address>",
  "mode": "shadow",
  "refs": [
    {
      "kind": "pyth",
      "feedId": "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
      "staleMs": 15000
    },
    {
      "kind": "binance",
      "symbol": "PAXGUSDT",
      "staleMs": 10000
    }
  ],
  "refQuorum": 2,
  "refMaxDispersionBps": 40,
  "detectors": {
    "quoteAuthority": {
      "pauseOnChange": true,
      "expected": [
        "<your quoting authority>"
      ]
    },
    "midDeviation": {
      "maxBps": 80
    },
    "drawdown": {
      "maxBps": 300,
      "windowMs": 64800000
    }
  }
}
```

## What it detects

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

## Safety defaults

- `dryRun: true` globally and `mode: "shadow"` per pool: the watchdog watches
  and logs `WOULD PAUSE`, and sends nothing.
- A pool only pauses for real when **all** of these hold: `dryRun: false`,
  `mode: "armed"`, the on-chain pause authority really is this key, warmup has
  elapsed, and the verdict persisted.
- If the pool's on-chain guard pauses first, our transaction fails with a
  benign "already in that state" error and is treated as success.

## Arming a pool

Do this only after a shadow period long enough to see normal market behavior
(a week is a good default) with no false `WOULD PAUSE` lines.

1. Your pool admin rotates the pause authority to this watchdog's key
   (`RotatePauseAuthority`). `npm run check` prints the key and verifies the
   match.
2. Set the pool's `mode: "armed"` and global `dryRun: false`.
3. Pin `quoteAuthority.expected` explicitly rather than relying on the value
   observed at boot.
4. Fund the pauser key (~0.05 SOL) for transaction fees; the service warns
   below `minSignerSol`.
5. Re-run `npm run check` — it must print "this watchdog ✓".

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

## Deploying

- **AWS (ECS Fargate)** — `./scripts/deploy-aws.sh --key ./pauser-keypair.json`
  does secrets, image build/push, and `terraform apply`. Options: `--name`,
  `--region`, `--config`, `--profile`, `--yes`. Re-runnable. The module uses
  your default VPC unless you pass `vpc_id`/`subnet_ids`, and deploys with no
  watchdog-coverage gap (the old task stays up until the new one is healthy).
- **Railway** — `./deploy.sh`, with `PAUSER_SECRET`, `GRPC_API_KEY` and
  `CONFIG_JSON` set as service variables.
- **Anywhere else** — the Docker image is self-contained and needs no private
  registry. It is pinned to `linux/amd64` because the Solana gRPC client ships
  no arm64 native binding.

## Development

```bash
npm run typecheck && npm test    # unit tests over the pure detector cores
npm run build && npm start
```

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. See the [LICENSE](./LICENSE) (Apache-2.0, §7 Disclaimer of Warranty
and §8 Limitation of Liability). In particular:

- hadron-pauser is a monitoring **aid**, not a guarantee. No representation is
  made that it will detect any particular event, act within any particular
  time, act only when intended, or run without interruption.
- Detection quality is a function of **operator configuration**: reference
  sources, thresholds, key custody, and the shadow period described above are
  the operator's responsibility.
- Running this watchdog does not reduce your own duty to secure your keys
  (quoting, admin, withdraw) and monitor your pools.
- No liability is accepted for any loss arising from use of, or reliance on,
  this software — including any loss it did not prevent.

[COVERAGE.md](./COVERAGE.md) describes what the watchdog is designed to cover
and what remains with you; read it before configuring.
