# hadron-pauser

A watchdog for [Hadron](https://hadron.fi) pools. It holds your pool's **pause
authority** key, compares the pool against independent reference prices, and
pauses the pool if it looks compromised.

That key can do exactly one thing on-chain: move the pool to `Paused`. It
cannot unpause, withdraw, quote, or change anything else — so this service can
run hot without widening your attack surface.

## Run it locally (5 minutes)

```bash
cp config.example.json config.json   # your pool address + reference feeds
cp .env.example .env                 # PAUSER_SECRET, GRPC_API_KEY, RPC URL
npm install
npm run check                        # decodes your pool, verifies the key, tests the feeds
npm run dev                          # starts in shadow mode — never sends a transaction
```

`npm run check` tells you plainly what it found, including whether your key is
actually the pool's pause authority yet.

## Deploy

```bash
./scripts/deploy-aws.sh --key ./pauser-keypair.json   # ECS Fargate, one command
```

Creates the secrets, builds and pushes the image, and applies the Terraform
module — service, IAM roles, log group, state bucket. Needs `aws`, `docker`
and `terraform`; uses your default VPC unless told otherwise. Then
`aws logs tail /ecs/hadron-pauser --follow`.

Railway: `./deploy.sh`, with `PAUSER_SECRET`, `GRPC_API_KEY` and `CONFIG_JSON`
set as service variables. Anywhere else:

```bash
docker build -t hadron-pauser .
docker run --env-file .env -v $PWD/config.json:/app/config.json hadron-pauser
```

## What you configure

Per pool in `config.json` — everything else has a working default. The
authoritative schema is `src/config.ts` (invalid config fails at boot), and
`config.example.json` is a working starting point.

| Setting | What it is |
|---|---|
| `config` | Your pool's address. |
| `refs` | Independent price sources — `pyth`, `binance`, or a `u64` at a fixed offset in another venue's on-chain oracle. Two beats one. |
| `quoteAuthority.expected` | The quoting key(s) you consider legitimate; `npm run check` prints the current one. Pin it before arming. |
| `midDeviation.maxBps` | How far the pool's mid may drift from those references before pausing. |
| `drawdown.maxBps` / `windowMs` | How much value the pool may lose in a rolling window. **Alerts** rather than pauses unless you set `pauseOnBreach`. |
| `refQuorum` / `refMaxDispersionBps` | How many sources must agree, and how far apart they may be before the reference is treated as untrustworthy. |
| `mode` / `dryRun` | Shadow vs armed. |

Starting points — classify the pair, then let a shadow period refine it:

| | LST ratio | Major | Stable | RWA, 24/7 |
|---|---|---|---|---|
| `midDeviation.maxBps` | 20 | 60 | 15 | 80 |
| `drawdown.maxBps` (18h window) | 120 | 200 | 80 | 300 |
| `refMaxDispersionBps` | 20 | 30 | 10 | 40 |
| `refQuorum` | 1 if that is all that exists | 2 | 2 | 2 |

To size them yourself: watch `midDeviationBps` in `/health` during the shadow
period and set the limit near 3× the worst value you see. For the drawdown
budget, note a real drain counts in *both* denominations (about twice the
value taken) while a price move counts about half its size, so take the worst
benign move you'd expect over the window and halve it before adding margin.

Only the quote-authority and mid-deviation detectors pause by default. The
drawdown budget alerts, because a false pause stops your pool quoting and that
budget has the widest false-positive surface — it is mark-to-market, so a
genuine market move consumes it. See [COVERAGE.md](./COVERAGE.md).

## Going live

New deployments run `dryRun: true` + `mode: "shadow"`: the watchdog watches,
logs what it *would* do, and sends nothing. Run it that way long enough to see
normal market behavior, then:

1. Your pool admin rotates the pause authority to this watchdog's key
   (`RotatePauseAuthority`); `npm run check` prints it and verifies the match.
2. Pin `quoteAuthority.expected` rather than relying on the boot-observed key.
3. Set `mode: "armed"` and `dryRun: false`.
4. Fund the pauser key (~0.05 SOL) for fees.
5. Re-run `npm run check` — it must print "this watchdog ✓".

## Docs

| | |
|---|---|
| [COVERAGE.md](./COVERAGE.md) | What it detects and is designed to cover, and what stays with you |
| [RUNBOOK.md](./RUNBOOK.md) | It paused — now what; alerts, state, health |
| [llms.txt](./llms.txt) | Playbook for an AI assistant to configure a pool for you |

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

Apache-2.0. Copyright © 2026 Hadron.
