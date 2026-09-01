# Railway (OTA project config-as-code)

Config-as-code for the Railway project that runs the self-hosted xprem OTA server
(`updates.boardsesh.com`). It is the same three-file shape as
[cloudflare.md](./cloudflare.md): typed desired state, a pure diff, and one script
that does all the I/O.

| File | Role |
| --- | --- |
| `infra/railway/config.ts` | Declarative desired state. No side effects, no API calls, **no secret values**. |
| `infra/railway/plan.ts` | Pure diff → `PlannedChange[]`. Unit-tested; no I/O. |
| `scripts/railway-apply.ts` | Fetches live state, builds the plan, reports or converges. |
| `scripts/railway-apply.test.ts` | Tests the plan layer. Needs no live project. |

```bash
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply              # dry-run
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply -- --apply   # converge
```

Dry-run is the default and **exits non-zero when there is drift**, so CI can gate on
it. A second `--apply` with nothing to do is a no-op.

## What it manages

- **Services.** Asserts `boardsesh-ota-v3` exists; reports when the ClickHouse
  service is missing. It never creates or deletes a service — see
  [Why services are not created](#why-services-are-not-created).
- **Variables.** Asserts the declared variables are set and are not still an
  unfilled `<placeholder>`.
- **ClickHouse retention.** Asserts the TTLs on xprem's `observe_metrics` and
  `observe_logs` tables.

A service that is live but not declared here is **reported and left alone**. The
project also holds Postgres and other services on purpose; a tool that removed what
it did not recognise would be a catastrophe rather than a convenience.

## Secrets

`infra/railway/config.ts` never holds a value. It declares that a variable must
exist and must not be a placeholder — the value lives in Railway.

`--apply` writes a variable only when the caller supplies its value in the script's
own environment as `RAILWAY_VAR_<NAME>`:

```bash
RAILWAY_VAR_CLICKHOUSE_URL='clickhouse://…' vp run railway:apply -- --apply
```

Without one, the drift is reported and left unapplied. A variable that is already
set and is not a placeholder is **never overwritten** — this tool cannot clobber a
working DSN with a stale one.

Values never reach a log line. `infra/railway/plan.ts` reduces every variable to
`set` / `absent` / `placeholder` before it can appear in a `PlannedChange`, and one
of the unit tests asserts a password cannot survive into the plan.

### Why placeholders are their own state

`npx eoas server:init` writes `CLICKHOUSE_URL=<clickhouse://user:password@host:9000/xprem>`
when you enable Observe without pasting a DSN. That value passes a naive "is it
set?" check and then fails at boot, so it is classified separately and reported with
a different message. The pattern is borrowed from xprem's own CLI, which uses the
identical regex to catch the identical mistake.

## ClickHouse retention

xprem's ClickHouse migrations ship **no TTL on any table**. Left alone,
`observe_metrics` and `observe_logs` grow until the volume fills.

The declared windows are 90 days for metrics and 30 for logs — logs carry the event
bodies and attribute blobs that dominate the bytes, while metrics are narrow numeric
rows worth comparing across releases months apart.

The check is skipped, not failed, when the script has no `CLICKHOUSE_URL` of its own
(the same way `scripts/mobile-ota-health-check.ts` skips without a PostHog key). It
reads over ClickHouse's HTTP interface on port 8123 and never writes.

> **The assertion cannot run from CI as written.** The DSN host is
> `boardsesh-ota-clickhouse.railway.internal`, which resolves only inside Railway's
> private network, so a GitHub Actions runner cannot reach port 8123 there. Setting
> `secrets.CLICKHOUSE_URL` today would turn the nightly drift check red on a
> connection error rather than on real drift — leave it unset until the check either
> runs through a tunnel or moves inside the network.

> **These tables are not ours.** xprem creates and migrates them through goose, so a
> server upgrade can recreate a table and silently drop a TTL we set out of band.
> That is why this is asserted on every run rather than being a one-time runbook
> step. The durable fix is a retention knob upstream in xprem; until that exists,
> this assertion is the guard.

To set or repair a TTL:

```sql
ALTER TABLE observe_metrics MODIFY TTL toDateTime(timestamp) + INTERVAL 90 DAY;
ALTER TABLE observe_logs    MODIFY TTL toDateTime(timestamp) + INTERVAL 30 DAY;
```

`toDateTime()` is required, not decoration. Both `timestamp` columns are
`DateTime64(9, 'UTC')`, and ClickHouse refuses a TTL whose result is not `Date` or
`DateTime`:

```
Code: 450. DB::Exception: TTL expression result column should have DateTime or
Date type, but has DateTime64(9, 'UTC'). (BAD_TTL_EXPRESSION)
```

### What fills the disk

Two separate things grow, and they are not the same size.

**xprem's Observe tables are small.** `update_health_snapshots` is the busiest by a
wide margin — `ee/observe/health_history.go` snapshots every current (update, role) on
a **one-minute** ticker, measured at ~259 rows per minute bucket, so ~373k rows/day.
That sounds alarming and is not: the rows are narrow and repetitive, and ClickHouse
stores them at about **2.6 bytes/row**, so ninety days is roughly 33.6M rows ≈ 87 MB.
Segment snapshots use a fixed five-minute bucket but fan out over eight dimensions.
`device_health_events` is the smallest, since it only fires when a device genuinely
changes update.

Note that this growth tracks how many *update rows* exist, not how many climbers use
the app — the per-PR `pr-*` branches are what drive it.

**ClickHouse's own system logs are the real consumer.** They ship almost no TTL:
`asynchronous_metric_log` alone wrote 55M rows in the first hour. Left alone the
`system` database grows by roughly 38 MB/day, unbounded — about a hundred times what
Observe itself uses. Every `system.*_log` MergeTree table has since been given a TTL
(14 days for the high-frequency instrumentation, 30 for the diagnostics worth
reading). These are ClickHouse's tables, not xprem's, so **re-check them after an image
upgrade** — a new server version can recreate a log table and drop the TTL with it.

### Disk headroom

`CLICKHOUSE_VOLUME_USAGE_LIMIT_PERCENT` in `infra/railway/config.ts` fails the run once
the volume passes 80% of its capacity. Every run prints the reading regardless:

```
[railway-apply] ClickHouse volume: 0.8 GiB of 48.8 GiB (1.7%).
```

Unlike the retention assertion, **this one does run in CI**, because it reads the volume
through Railway's own API rather than by connecting to ClickHouse. Railway answers a
GitHub Actions runner; `boardsesh-ota-clickhouse.railway.internal` does not.

It is worth gating on because a full volume is not merely a storage problem. ClickHouse
stops accepting writes, and since xprem calls `log.Fatalf` when ClickHouse is
unreachable at boot, the next OTA restart would then fail to come up at all — a full
disk here is an availability risk for `updates.boardsesh.com`.

### The three tables that fill without any app release

`observe_metrics` and `observe_logs` are fed by the app's telemetry sink, so they
stay empty until the mobile app ships `expo-observe`. The other three fill straight
away from ordinary manifest check-ins, because Postgres triggers enqueue into
`device_health_outbox` and a worker drains it into ClickHouse:

| Table | Time column | Retention | Why |
| --- | --- | --- | --- |
| `update_health_snapshots` | `bucket` | 90d | One-minute samples; nothing reads minute grain a quarter later |
| `update_health_segment_snapshots` | `bucket` | 90d | Five-minute samples, but eight dimensions wide |
| `device_health_events` | `occurred_at` | 180d | Lowest volume and the raw record the other two summarise |

`observe_metrics` and `observe_logs` need `expo-observe` in the mobile app, which is a
native module — so a new fingerprint and a store release. **The three above need
nothing from the app.** Postgres triggers enqueue into `device_health_outbox` on every
device update-state change, driven by the manifest check-ins every production binary
already makes, and a worker drains that into ClickHouse. So the rollout and adoption
views work today; only the startup and navigation timings wait on a release.

## Why services are not created

A ClickHouse service is only correct with a persistent volume mounted at
`/var/lib/clickhouse`. A service created without one looks perfectly healthy and
loses every row on each redeploy, and a name lookup that misses would create a
*second* service rather than reusing the first. Neither has a cheap undo.

So the tool reports exactly what is missing and what to create, and applies only
variables — which are safe and idempotent. This mirrors how the Cloudflare tool
reports a zone-wide SSL change instead of applying it. Widening this to
`serviceCreate` + `volumeCreate` is a deliberate follow-up, not an oversight.

## How it runs in CI

`.github/workflows/railway-drift.yml` has two jobs, split by trigger:

- **`drift`** — schedule (06:30 UTC) and `workflow_dispatch`. Runs the real dry-run
  against the live project and fails on drift. It needs `secrets.RAILWAY_TOKEN`, which
  lives in the **Production** environment.
- **`validate`** — pull requests touching `infra/railway/**` or the apply script. Runs
  the plan layer's tests and typechecks the script.

They are split because the Production environment's deployment branch policy admits
`main` alone. A pull request runs as `refs/pull/N/merge`, so a job asking for that
environment is rejected outright — "Branch is not allowed to deploy to Production" —
before any step executes, which no in-script skip can catch.

The cost is that a service name misspelled against the *live* project is caught by the
nightly run rather than on the PR. Closing that gap means a second environment holding
the token with no branch policy; that is a security call, not a workflow tweak.

`vars.RAILWAY_PROJECT_ID` must be set as a repository variable or the `drift` job skips
itself with a notice.

## Env

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAILWAY_TOKEN` | yes | Railway API token. The same secret the production deploy already uses against `backboard.railway.com`. It is a **project** token, scoped to this project and its production environment, so it authenticates with `Project-Access-Token` — not `Authorization: Bearer`, which is for account tokens. The script tries one and falls back to the other, so either kind works. |
| `RAILWAY_PROJECT_ID` | yes | The project holding the OTA services. |
| `RAILWAY_VAR_<NAME>` | no | A value `--apply` may write for a declared variable. Never logged. |
| `CLICKHOUSE_URL` | no | Enables the retention assertion. Read-only. **Do not add this as a CI secret yet** — see the reachability note under ClickHouse retention. |

## Related

- [mobile-ota-updates.md](./mobile-ota-updates.md) — the OTA server itself: hosting,
  versions, the publish path, and the cutover history.
- [cloudflare.md](./cloudflare.md) — the same config-as-code pattern for the
  `boardsesh.com` zone.
