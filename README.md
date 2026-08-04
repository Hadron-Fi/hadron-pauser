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

### What you choose

In `config.json`, per pool — everything else has a working default:

- **`config`** — your pool's address
- **`refs`** — independent price sources (Pyth, Binance, another venue's
  on-chain oracle); two beats one
- **`quoteAuthority.expected`** — the quoting key(s) you consider legitimate
- **`midDeviation.maxBps`** — how far the pool's mid may drift from those
  references before pausing
- **`drawdown.maxBps` / `windowMs`** — how much value the pool may lose in a
  rolling window before it alerts (this one alerts rather than pauses until
  you opt in — see `pauseOnBreach`)

[CONFIGURATION.md](./CONFIGURATION.md#the-values-you-choose) has starting
numbers per asset class (LST ratio, major, stable, RWA) and how to size them.

## Deploy to AWS (one command)

```bash
./scripts/deploy-aws.sh --key ./pauser-keypair.json
```

Creates the secrets, builds and pushes the image, and applies the Terraform
module — ECS Fargate service, IAM roles, log group, state bucket. Needs `aws`,
`docker` and `terraform`; uses your default VPC unless told otherwise. Then:
`aws logs tail /ecs/hadron-pauser --follow`.

Docker anywhere else:

```bash
docker build -t hadron-pauser .
docker run --env-file .env -v $PWD/config.json:/app/config.json hadron-pauser
```

## Defaults are safe

New deployments run `dryRun: true` + `mode: "shadow"`: the watchdog watches,
logs what it *would* do, and sends nothing. Going live is deliberate — rotate
the pause authority to this key, then flip both switches. Run it in shadow
long enough to see normal market behavior first.

## Docs

| | |
|---|---|
| [CONFIGURATION.md](./CONFIGURATION.md) | Detectors, every setting, alerts, state, arming |
| [COVERAGE.md](./COVERAGE.md) | What it is designed to cover, and what stays with you |
| [RUNBOOK.md](./RUNBOOK.md) | It paused — now what |
| [llms.txt](./llms.txt) | Playbook for an AI assistant to configure a pool for you |

## Disclaimer

Provided **as is**, without warranty of any kind — see [LICENSE](./LICENSE)
and the [full disclaimer](./CONFIGURATION.md#disclaimer). This is a monitoring
aid, not a guarantee; securing your keys and monitoring your pools remain your
responsibility.

Apache-2.0. Copyright © 2026 Hadron.
