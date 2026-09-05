# Railway (OTA project config-as-code)

Config-as-code for the Railway services that run the self-hosted xprem OTA server
(`updates.boardsesh.com`). It is the same three-file shape as
[cloudflare.md](./cloudflare.md): typed desired state, a pure diff, and one script
that does all the I/O.

| File | Role |
| --- | --- |
| `infra/railway/config.ts` | Declarative desired state. No side effects, no API calls, **no secret values**. |
| `infra/railway/plan.ts` | Pure diff → `PlannedChange[]`. Unit-tested; no I/O. |
| `scripts/railway-apply.ts` | Fetches live state, builds the plan, reports or converges. |
| `scripts/ota-image-bump.ts` | Finds newer xprem releases and rewrites the repo onto one. |
| `scripts/railway-apply.test.ts` | Tests the plan layer. Needs no live project. |

```bash
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply                                   # dry-run
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply -- --apply                        # converge
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... vp run railway:apply -- --apply --allow-image-change   # + roll a new image
```

Dry-run is the default and **exits non-zero when there is drift**, so CI can gate on
it. A second `--apply` with nothing to do is a no-op.

## Why not `railway.toml`

Web and backend use Railway's own config-file mechanism (`railway.toml`,
`railway.web.toml`). That file is read **from the service's source repository at
deploy time**, and `boardsesh-ota-v3` is sourced from a third-party GHCR image with
no repo of ours attached — there is nothing for Railway to read a config file out
of. The API is the only config-as-code path for this service, which is what this
tool is.

> Railway's Config-as-Code is also deprecated, with a cutoff of **2026-12-01**;
> new services cannot opt in at all. That is a separate migration for the backend
> and web services, and worth deciding deliberately: `railway config plan
> --detailed-exit-code` overlaps closely with what this tool already does.

## What it manages

| | `boardsesh-ota-v3` | `boardsesh-ota-clickhouse` | `Postgres` | everything else |
| --- | --- | --- | --- | --- |
| Level | `managed` | `managed` | `assert-only` | `inventory` |
| Image | applied | asserted | left alone | — |
| Deploy settings | applied | — | — | — |
| Variables | applied / asserted | — | — | — |
| Domains, volumes, scale | reported | reported | reported | — |

- **The image.** `OTA_SERVER_VERSION` in `infra/railway/config.ts` is the one place
  the deployed xprem version is written down. Applying it rolls a deployment —
  see [Upgrading the OTA server](#upgrading-the-ota-server).
- **Deploy settings.** Healthcheck path and timeout, restart policy, and the
  draining window. All safe, all reversible, all applied.
- **Variables.** A variable declared **with a value** is configuration this repo
  owns and converges. A variable declared **by name only** is a secret: asserted
  present and not an unfilled `<placeholder>`, never printed, never overwritten
  once set. See [Secrets](#secrets).
- **Variables that must not be set.** `forbiddenVars` catches the ones that would
  switch xprem out of control-plane mode. Reported, never deleted.
- **Custom domains, volume mounts, replicas, region.** Read and reported, never
  applied. Each is either half of a change that lives somewhere else, a create, or
  a decision with a bill attached.
- **ClickHouse retention.** Asserts the TTLs on xprem's `observe_*` and health
  tables.

A service that is live but not declared at all is **reported and left alone**. The
five services this repo does not manage are listed as `inventory` with a `managedBy`
note, so that report fires for a genuinely *new* service — which is worth seeing —
rather than the same five lines every night.

## Upgrading the OTA server

Bump `OTA_SERVER_VERSION` in `infra/railway/config.ts` and `EOAS_PACKAGE_SPEC` in
`scripts/lib/eoas.ts` together, in one PR. Merging it is what performs the upgrade:
`railway-drift.yml`'s `apply` job runs on push to `main` and

1. writes the deploy settings and the new image (`serviceInstanceUpdate`),
2. rolls a deployment (`serviceInstanceDeployV2`, which returns its id),
3. polls until three consecutive `SUCCESS` readings,
4. probes `/hc` and `/ready`,
5. **rolls back and restores the previous image** if either step fails.

`vp run ota:image-bump` opens those PRs for you — see
[Upgrade PRs](#upgrade-prs-stable-and-beta).

Three things gate the image change, and all three matter:

- **`--allow-image-change`.** `--apply` alone will not move the image. Rolling a
  new container on the server every production binary talks to is a categorically
  larger act than correcting a healthcheck path, so it is asked for explicitly —
  the same shape as `cf:apply`'s `--allow-zone-ssl`. The nightly drift job never
  passes it; the apply job does.
- **The CLI may lead the server, never trail it.** `infra/railway/plan.ts` blocks
  an image whose version is ahead of `EOAS_PACKAGE_SPEC`, because a CLI that trails
  can 404 on app-scoped routes. `scripts/__tests__/eoas-version-parity.test.ts`
  asserts the same thing without needing the API.
- **The service must be quiet.** A deployment already in flight aborts the run
  rather than stacking a second one on top of it.

### Step 5 is the part worth reading twice

`deploymentRollback` restores the *running container*. It does not touch the
service's configured `source.image`, so a rollback alone would leave the config
naming the bad tag — and the next unrelated deploy would silently ship it again.
So the failure path issues a second `serviceInstanceUpdate` to put the previous
image back, and says so loudly if that second write fails, because that is the one
genuinely bad state this feature can reach.

If the service has never had a second successful deployment there is **no rollback
target**, and the run warns about that *before* deploying rather than discovering
it afterwards.

### After any bump

- `vp dlx eoas@<version> doctor --channel=production`.
- **Re-check the ClickHouse `system.*_log` TTLs.** They are ClickHouse's tables, not
  xprem's, and a server image upgrade can recreate one without its TTL. See
  [What fills the disk](#what-fills-the-disk).

## Upgrade PRs (stable and beta)

`.github/workflows/ota-image-bump.yml` runs weekly and opens a **draft PR per
candidate**. `vp run ota:image-bump` does the same locally:

```
[ota-image-bump] Deployed server 3.1.2, publishing with eoas 3.1.2.
  newest stable: 3.1.3
  newest prerelease: 3.2.0-beta3
```

**Two candidates, not one.** A prerelease outranks a stable release by semver —
`3.2.0-beta3` > `3.1.3` — so a single "newest version" search would propose the beta
and quietly bury the stable upgrade behind it. They are tracked separately and each
gets its own branch, so both are visible and each is merged on its own merits. The
prerelease PR says so in its body.

Ordering has one deliberate departure from strict semver. Upstream writes betas two
ways, `v3.0.0-beta.3` and `v3.2.0-beta1`, and the spec compares alphanumeric
identifiers in ASCII order — which ranks `beta10` *below* `beta2`. On the day xprem
ships a tenth beta a spec-pure comparison would propose the ninth as the newest, so
a trailing number on an identifier is compared numerically.

The bump rewrites every file that names the version — the parity test polices the
same list — and both halves move in one commit, so the CLI can never end up
trailing the server.

## Secrets

`infra/railway/config.ts` holds a value only for non-secret configuration, which is
what makes that value safe to print: it is already in git. Everything else is
declared by name, and the value lives in Railway.

`--apply` writes a name-only variable solely when the caller supplies its value in
the script's own environment as `RAILWAY_VAR_<NAME>`:

```bash
RAILWAY_VAR_CLICKHOUSE_URL='clickhouse://…' vp run railway:apply -- --apply
```

Without one, the drift is reported and left unapplied. A secret that is already set
and is not a placeholder is **never overwritten** — this tool cannot clobber a
working DSN with a stale one.

Values never reach a log line. `infra/railway/plan.ts` reduces every name-only
variable to `set` / `absent` / `placeholder` before it can appear in a
`PlannedChange`, and for a variable this repo owns it prints the *declared* value on
a mismatch and never the live one. Unit tests assert a password cannot survive into
the plan on either path.

### Why the draining window is a deploy setting, not a variable

Railway exposes the SIGTERM-to-SIGKILL window two ways: `drainingSeconds` on the
service instance, and a `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable. Both would
work. The typed field is used because the variable route would need an exception to
"never overwrite a value that is already set" — and that rule is exactly what
protects a live DSN. A numeric knob is not worth qualifying it.

### Why placeholders are their own state

`npx eoas server:init` writes `CLICKHOUSE_URL=<clickhouse://user:password@host:9000/xprem>`
when you enable Observe without pasting a DSN. That value passes a naive "is it
set?" check and then fails at boot, so it is classified separately and reported with
a different message. The pattern is borrowed from xprem's own CLI, which uses the
identical regex to catch the identical mistake.

## Why the schema is introspected before a write

Railway's published field list for `ServiceInstanceUpdateInput` is hand-curated and
omits both `source` and `drainingSeconds` — the two fields that make this tool's
apply path possible. The schema itself is the only trustworthy answer, and
introspection is open on `backboard.railway.com` with no token, so `--apply` checks
it for the cost of one unauthenticated POST. If a field it writes ever disappears,
it says so instead of sending a mutation nobody can reason about.

## ClickHouse retention

xprem's ClickHouse migrations ship **no TTL on any table**. Left alone,
`observe_metrics` and `observe_logs` grow until the volume fills.

The declared windows are 90 days for metrics and 30 for logs — logs carry the event
bodies and attribute blobs that dominate the bytes, while metrics are narrow numeric
rows worth comparing across releases months apart. Three server-side health tables
carry 90/90/180 windows; all five are in `CLICKHOUSE_RETENTION`.

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

Growing the volume is a dashboard action, and not out of caution: `sizeMB` appears on
no input type anywhere in Railway's schema, so resizing is not something the API
permits at all.

### Where each table's rows come from

Two independent producers, which is why the tables filled at very different times.

| Table | Time column | Retention | Producer |
| --- | --- | --- | --- |
| `update_health_snapshots` | `bucket` | 90d | Server. One-minute samples; nothing reads minute grain a quarter later |
| `update_health_segment_snapshots` | `bucket` | 90d | Server. Five-minute samples, but eight dimensions wide |
| `device_health_events` | `occurred_at` | 180d | Server. Lowest volume and the raw record the other two summarise |
| `observe_metrics` | `timestamp` | 90d | App. Per-screen `cold_ttr` / `warm_ttr` / `tti` |
| `observe_logs` | `timestamp` | 30d | App. Log events and error reports |

**The three server-side tables need nothing from the app.** Postgres triggers enqueue
into `device_health_outbox` on every device update-state change, driven by the manifest
check-ins every production binary already makes, and a worker drains that into
ClickHouse. They have been filling since Observe was switched on.

**The two app-side tables are fed by `expo-observe`**, wired up in
`packages/mobile/src/lib/observe-bootstrap.ts`. Because that pulls in native modules the
fingerprint moved, so rows only arrive from binaries built after that shipped — an older
store build reports nothing no matter how long it runs. Two PostHog flags control it
without a new build: `observe-dispatch-enabled` (kill switch) and `observe-sample-rate`.
See `docs/feature-flags.md`.

> **The 90d/30d windows on the app-side tables were chosen while both were empty.**
> `observe_metrics` takes a row per navigation per device, which is a different order of
> magnitude from the server-side tables. Re-measure once real traffic has been flowing
> for a week — the query is under "What fills the disk" above.

## Why services are not created

A ClickHouse service is only correct with a persistent volume mounted at
`/var/lib/clickhouse`. A service created without one looks perfectly healthy and
loses every row on each redeploy, and a name lookup that misses would create a
*second* service rather than reusing the first. Neither has a cheap undo.

So the tool reports exactly what is missing and what to create. Changing an
*existing* service is a different risk and is automated: it is reversible by
changing the constant back, Railway keeps the deployment history, and the apply
path verifies its own result.

The same reasoning covers what stays report-only on an existing service. A custom
domain is only half a change — the other half is the DNS record in
`infra/cloudflare/config.ts` — and creating one side alone leaves a domain that
never verifies. Replica count has a bill attached, and Railway's replica state
lives in an opaque `multiRegionConfig` JSON that a scalar write does not reliably
move. Changing a region relocates a running service.

## Why `Postgres` is asserted, not managed

The OTA control-plane database runs `ghcr.io/railwayapp-templates/postgres-ssl:18`
with Railway's own vulnerability auto-updates (`tagMode: sha`). Pinning an image
there would fight Railway's patching of the database that holds **the only copy of
the app's private signing key**. So its image is deliberately left alone and only
its volume mount is asserted — a Postgres that lost its volume looks perfectly
healthy and would take that key with it on the next redeploy.

## How it runs in CI

`.github/workflows/railway-drift.yml` has three jobs, split by trigger:

- **`apply`** — push to `main` touching `infra/railway/**` or the apply script.
  Runs `--apply --allow-image-change` against the live project. This is what makes
  a merged version bump an upgrade. Needs `secrets.RAILWAY_TOKEN`.
- **`drift`** — schedule (06:30 UTC) and `workflow_dispatch`. Runs the real dry-run
  and fails on drift. Never passes `--allow-image-change`.
- **`validate`** — pull requests touching `infra/railway/**` or the scripts. Runs
  the plan layer's tests and typechecks. No credentials.

They are split because the Production environment's deployment branch policy admits
`main` alone. A pull request runs as `refs/pull/N/merge`, so a job asking for that
environment is rejected outright — "Branch is not allowed to deploy to Production" —
before any step executes, which no in-script skip can catch.

The cost is that a service name misspelled against the *live* project is caught by the
nightly run rather than on the PR. Closing that gap means a second environment holding
the token with no branch policy; that is a security call, not a workflow tweak.

`vars.RAILWAY_PROJECT_ID` must be set as a repository variable or the jobs skip
themselves with a notice.

The workflow-level concurrency deliberately does **not** cancel a push run: an
`apply` can be mid-deploy, between writing a service's image and confirming the
deployment that carries it, which is the one moment where being killed leaves the
declared config and the running container disagreeing.

> **`RAILWAY_TOKEN`'s blast radius grew.** The same credential that used to read,
> and write one variable it was handed, can now roll a container image. That is a
> real widening even behind `--allow-image-change`, and worth remembering when
> deciding where that secret lives.

## Env

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAILWAY_TOKEN` | yes | Railway API token. The same secret the production deploy already uses against `backboard.railway.com`. It is a **project** token, scoped to this project and its production environment, so it authenticates with `Project-Access-Token` — not `Authorization: Bearer`, which is for account tokens. The script tries one and falls back to the other, so either kind works — but the rollback path needs a project token specifically, since it derives its scope from `projectToken`. |
| `RAILWAY_PROJECT_ID` | yes | The project holding the OTA services. |
| `RAILWAY_VAR_<NAME>` | no | A value `--apply` may write for a declared secret. Never logged. |
| `CLICKHOUSE_URL` | no | Enables the retention assertion. Read-only. **Do not add this as a CI secret yet** — see the reachability note under ClickHouse retention. |

## Related

- [mobile-ota-updates.md](./mobile-ota-updates.md) — the OTA server itself: hosting,
  versions, the publish path, and the cutover history.
- [cloudflare.md](./cloudflare.md) — the same config-as-code pattern for the
  `boardsesh.com` zone.
- [production-deploy.md](./production-deploy.md) — the web/backend deploy path, and
  why `drainingSeconds` exists.
