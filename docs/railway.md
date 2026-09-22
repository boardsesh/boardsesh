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

`--no-wait` is a local diagnostic escape hatch: it skips deployment polling and
post-deploy probes, so it also skips failure detection and automatic rollback.
Do not use it in the production apply workflow; manually verify any deployment
started with this flag.

## Why not `railway.toml`

The repo retains `railway.toml` and `railway.web.toml` for backend and web
configuration. Their presence does not prove Railway reads them: only existing
services already using the legacy config-file mechanism retain support until
the cutoff below. Track service adoption and migration in
[#5041](https://github.com/boardsesh/boardsesh/issues/5041). The OTA service
`boardsesh-ota-v3` is sourced from a third-party GHCR image with no repository of
ours attached, so this tool manages its declared settings through the API.

> [Railway's Config-as-Code documentation](https://docs.railway.com/config-as-code)
> specifies a **2026-12-01** cutoff for existing users; new services cannot opt in.
> The backend/web migration remains a separate decision in #5041, including
> whether `railway config plan --detailed-exit-code` replaces overlapping checks.

## What it manages

| | `boardsesh-ota-v3` | `boardsesh-ota-clickhouse` | `Postgres` | `PostGIS - PG18` | `boardsesh-web` | everything else |
| --- | --- | --- | --- | --- | --- | --- |
| Level | `managed` | `managed` | `assert-only` | `assert-only` | `assert-only` | `inventory` |
| Image | applied | applied | left alone | left alone | left alone | — |
| Deploy settings | applied | — | — | — | — | — |
| Variables | applied / asserted | — | — | asserted | asserted | — |
| Domains, volumes, scale | reported | reported | reported | — | — | — |

- **The image.** `OTA_SERVER_VERSION` in `infra/railway/config.ts` is the one place
  the deployed xprem version is written down. Applying it rolls a deployment —
  see [Upgrading the OTA server](#upgrading-the-ota-server).
- **Deploy settings.** Healthcheck path and timeout, restart policy, and the
  draining window. All safe, all reversible, all applied.
- **Variables.** A variable declared **with a value** is configuration this repo
  owns and converges. A variable declared **by name only** is presence-only:
  asserted present and not an unfilled `<placeholder>`, never printed, never
  overwritten once set. This covers secrets and the provider-managed
  `AWS_BASE_ENDPOINT`, so merging cannot restore a stale storage endpoint. For
  `PostGIS - PG18`, this also asserts that `PG_TLS_SERVER_CERT` and
  `PG_TLS_SERVER_KEY` are present without reading either value into git.
- **The OTA cache variables.** `boardsesh-ota-v3` needs `REDIS_HOST`,
  `REDIS_PORT` and `REDIS_PASSWORD` set (by name only; they are Railway references
  to the shared Redis), and two public values pinned exactly: `CACHE_MODE` must be
  `redis` and `CACHE_KEY_PREFIX` must be `boardsesh-ota`. Absent or any other value
  is drift, and the remediation is always to set the pinned value, never to remove
  it. Without `CACHE_MODE`, xprem quietly falls back to its local in-process cache,
  which has no size bound and grew to a 1.7 GB heap; the server keeps working, so
  only this check notices. xprem has no default for `REDIS_PORT`, so a missing port
  or host makes its Redis connection check panic. `CACHE_KEY_PREFIX` pins the key
  names (unset, xprem uses `expoopenota`); any other prefix silently moves every
  cached manifest, lock and rate-limit counter to a new key namespace. With
  `CACHE_MODE=redis`, Redis is a hard dependency of OTA delivery: xprem pings Redis
  once, in a `sync.Once`, on its first cache use (the bucket-migration lock at boot)
  and panics if the ping fails. That is why the declared restart policy is `ALWAYS`:
  the server retries until Redis answers, and the race is most likely during
  Railway's Redis auto-update window (weekends).
- **Variables that must not be set.** `forbiddenVars` catches the ones that would
  switch xprem out of control-plane mode. Reported, never deleted.
- **Custom domains, volume mounts, replicas, region.** Read and reported, never
  applied. Each is either half of a change that lives somewhere else, a create, or
  a decision with a bill attached.
- **ClickHouse retention.** Asserts the TTLs on xprem's `observe_*` and health
  tables.

A service that is live but not declared at all is **reported and left alone**. The
four services this repo does not manage are listed as `inventory` with a `managedBy`
note, so that report fires for a genuinely *new* service — which is worth seeing —
rather than the same four lines every night.

`PostGIS - PG18` is declared for its **TLS variables alone**. Its image digest,
volume and networking remain under the reviewed publish flow in
[postgres-image-publishing.md](./postgres-image-publishing.md); the Railway drift
job never changes them.

## Upgrading the OTA server

Bump `OTA_SERVER_VERSION` in `infra/railway/config.ts` and `EOAS_PACKAGE_SPEC` in
`scripts/lib/eoas.ts` together, in one PR. Merging it is what performs the upgrade:
`railway-drift.yml`'s `apply` job runs on push to `main` and

1. writes the deploy settings and the new image (`serviceInstanceUpdate`),
2. rolls a deployment (`serviceInstanceDeployV2`, which returns its id),
3. polls until three consecutive `SUCCESS` readings,
4. probes `/hc` and `/ready`,
5. **rolls back and restores the previous configuration** if either step fails.

A run touching multiple services behaves as one deployment batch. If a later
service fails, every earlier verified deployment is rolled back in reverse order;
variables remain set because Railway's deployment rollback cannot undo variable
configuration. Before the first write, every waited multi-service batch verifies
that each service has a rollback target. Token rollback capability is a hard
preflight only when the batch changes an image. Non-image changes still deploy and
probe, and failures trigger a best-effort unwind; that unwind needs a project token
to succeed.

`vp run ota:image-bump` opens those PRs for you — see
[Upgrade PRs](#upgrade-prs-stable-and-beta).

Four things gate the image change, and all four matter:

- **`--allow-image-change`.** `--apply` alone will not move the image. Rolling a
  new container on the server every production binary talks to is a categorically
  larger act than correcting a healthcheck path, so it is asked for explicitly —
  the same shape as `cf:apply`'s `--allow-zone-ssl`. The nightly drift job never
  passes it; the apply job does.
- **The CLI may lead the server, never trail it.** `infra/railway/plan.ts` blocks
  the OTA image if its version is ahead of `EOAS_PACKAGE_SPEC`, because a CLI that trails
  can 404 on app-scoped routes. `scripts/__tests__/eoas-version-parity.test.ts`
  asserts the same thing without needing the API. ClickHouse has its own version
  series and is not compared to eoas; its image changes still require explicit opt-in.
- **The service must be quiet.** A deployment already in flight aborts the run
  rather than stacking a second one on top of it.
- **The token must be able to roll back.** `railwayRequest` probes both auth
  schemes, so an *account* token drives the whole apply happily — but the rollback
  helper sends only `Project-Access-Token` and reads `projectToken` for its scope,
  which an account token answers as null. Unchecked, that mismatch surfaces at the
  single worst moment: a bad image live, the probe failed, and the recovery path
  dying immediately. So an image change asks first, and refuses if the answer is no.

### Step 5 is the part worth reading twice

`deploymentRollback` restores the *running container*. It does not touch deploy
settings or the configured `source.image`, so a rollback alone would leave the
next deploy ready to re-ship the failed configuration. The failure path therefore
issues a second `serviceInstanceUpdate` restoring exactly the fields this run
changed, including prior nulls. It says so loudly if any rollback or restore fails.

Environment variables are separate from that recovery. Every `variableUpsert`
uses `skipDeploys: true`, then the service gets one deployment carrying the whole
batch. Neither `deploymentRollback` nor the deploy-setting/configuration restore
undoes those variable writes, so they survive a failed single-service apply and a
failed multi-service batch. After either failure, inspect each affected service's
**Production → Variables** page in Railway, compare it with `infra/railway/config.ts`
and the secrets supplied to the failed run, then manually restore the previous
value or remove the newly added variable before re-running the drift workflow.

If a service in a multi-service batch has no rollback target, the run refuses the
whole batch before its first write. Single-service applies retain the existing
best-effort policy even without a prior rollback target. The tool warns for an
image change without a target; a failed rollout without one requires manual
reconciliation. This does not relax the separate image-change token capability
check.

Two failures deliberately do *not* roll back the current service. If its deployment
was canceled/parked or carries somebody else's image, rollback could undo a newer
or manual action. Earlier services completed by the same run are still unwound.
Every recovery is best-effort across the whole stack, followed by an aggregate
`MANUAL ACTION` warning when anything could not be restored.

### Configured is not running

`serviceInstanceUpdate` writes configuration; the container keeps what it was
created with until the next deployment. A run killed between those two steps leaves
them disagreeing — and a drift check reading only the configured image would call
that in sync forever, while the next unrelated deploy shipped the never-probed
image. So the plan compares the **running** deployment's `meta.image` too and
reports the split. Configured-versus-running disagreement blocks writes to that
service until an operator reconciles it.

The reader identifies the serving image and rollback baseline from exactly one
active `SUCCESS` deployment. A newer failed or canceled attempt is not that
baseline. Missing image metadata, no active success, or multiple active successes
block writes to an image-managed service; the tool cannot prove convergence or
safely choose a deployment to restore. A known serving deployment whose
`canRollback` is false still follows the single-service best-effort and
multi-service refusal policies above.

### The probe retries

`/hc` and `/ready` are probed three times with a short backoff, not once. The probe
runs during the switchover the service's own `drainingSeconds` exists to cover, and
a single 502 from the edge is indistinguishable from a broken server — treating one
as a failure would roll back a perfectly healthy production deployment.

### When an upgrade fails

**Revert the bump PR.** The rollback restores the container and the *configured*
image, but `OTA_SERVER_VERSION` in the repo still names the bad tag — so the next
push touching `infra/railway/**` sees the same drift and attempts the same upgrade
again. Nothing else re-triggers it (the `apply` job is path-filtered, so unrelated
pushes to `main` do not), but a second infra change would, and each attempt rolls a
production deployment. Reverting the version is what actually stops it.

**A deployment parked on `NEEDS_APPROVAL` is left alone**, not rolled back — nothing
is broken and releasing it is a human's call. Approve or cancel it in Railway, then
re-run.

**The two mutations are never retried**, on purpose: an ambiguous response may mean
Railway already accepted the call, and retrying would create a second deployment. So
a timeout on `serviceInstanceUpdate` or `serviceInstanceDeployV2` leaves the run
failed with a deployment possibly in flight. Wait for the service to go quiet — the
next run refuses to touch a service that is not — then re-run.

### After any bump

- `vp dlx eoas@<version> doctor --channel=production`.
- Check `https://updates.boardsesh.com/ready` and that the Observe dashboard still
  renders. An xprem bump never touches ClickHouse's own tables: the lean image
  disables the system logs in config (see [What fills the disk](#what-fills-the-disk)).

## Upgrade PRs (stable and beta)

`.github/workflows/ota-image-bump.yml` runs each Monday at 07:15 UTC and opens a
**draft PR per candidate**. `vp run ota:image-bump` does the same locally:

```
[ota-image-bump] Declared server 3.1.2, publishing with eoas 3.1.2.
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

`infra/railway/config.ts` holds a value only for repo-owned, non-secret
configuration, which is what makes that value safe to print: it is already in git.
Everything else is declared by name, and the value lives in Railway.

`--apply` writes a name-only variable solely when the caller supplies its value in
the script's own environment as `RAILWAY_VAR_<NAME>`:

```bash
RAILWAY_VAR_CLICKHOUSE_URL='clickhouse://…' vp run railway:apply -- --apply
```

Without one, the drift is reported and left unapplied. A presence-only value that
is already set and is not a placeholder is **never overwritten** — this tool cannot
clobber a working DSN or storage endpoint with a stale one.

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
a different message. The pattern is borrowed from xprem's own CLI, which catches the
identical mistake.

It is **anchored**, unlike theirs. An unanchored pattern matches any value merely
*containing* a bracketed run, and `ADMIN_PASSWORD` is the one variable whose policy
requires a symbol — so `hunter<2>!Ab` is a plausible real password. Misreading a
live secret as a placeholder is not cosmetic: it makes the variable convergeable, so
a supplied value would overwrite a working one, breaking the rule that a set secret
is never clobbered.

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

The database name is the sole value interpolated into that read-only SQL. The tool
accepts only an unquoted ClickHouse identifier (`[A-Za-z_][A-Za-z0-9_]*`), which is
the SQL-injection boundary rather than a cosmetic naming check.

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
Observe itself uses. In September every `system.*_log` MergeTree table was given a TTL
by hand (14 days for the high-frequency instrumentation, 30 for the diagnostics worth
reading). Those TTLs lived in table metadata, so a new server version could recreate a
log table and drop the TTL with it.

**The image now does this instead.** `docker/clickhouse/config.d/boardsesh-lean.xml`
removes every system log except `query_log`, and gives `query_log` a 7-day TTL in
config, where an image upgrade cannot lose it. The same file caps the server at
1.2 GB and shrinks the caches, which is where the memory bill came from: the stock
server idled at 2.9 GB under a 24 GB ceiling. `users.d/boardsesh-query-memory.xml`
caps each query at 500 MB, so one runaway dashboard query fails alone instead of
filling the 1.2 GB and failing the OTA server's inserts with it. The hand-set TTLs
are superseded once the image is live and the one-off `DROP` below has run.
`docker/clickhouse/smoke.sh` proves the config on every PR that touches it,
including a first boot on a volume the stock image wrote.

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

### Rolling out a new ClickHouse image

The service runs `ghcr.io/boardsesh/boardsesh-clickhouse`, built from `docker/clickhouse`:
stock `clickhouse/clickhouse-server:25.3` (the version xprem tests against, pinned by
digest) plus one config file. It is published only by hand and pinned by digest, the
same convention as the WAL-G image.

Currently published digest:
`ghcr.io/boardsesh/boardsesh-clickhouse@sha256:80d3d4c0dfacbd845476eea56ca239a3d658e868e01389ed264e1a9ecf56f6fd`
(tag `sha-cb144344cdf0d1182737c1356f888cb1f685800d`, published 2026-09-26) — keep this
line current so the next rollout has a rollback target. Pinned in production at
2026-09-26 03:08 UTC with the 2 GB / 2 vCPU ceiling; live settings and the
system-log cleanup are recorded in `docs/railway-cost-reduction.md`.

**Never restart the OTA server (`boardsesh-ota-v3`) while ClickHouse is down.** xprem
calls `log.Fatalf` when ClickHouse is unreachable at boot, so an OTA restart during
the ClickHouse restart takes `updates.boardsesh.com` down with it. Restart ClickHouse
alone; a running OTA server rides out a short ClickHouse outage.

1. **Publish.** Actions → *ClickHouse Image* → Run workflow on `main`. The smoke job
   runs first; the publish job's summary prints
   `ghcr.io/boardsesh/boardsesh-clickhouse@sha256:…`.
2. **Make it public.** A new GHCR package starts private, and Railway pulls
   `ghcr.io/boardsesh/*` anonymously: `boardsesh-postgres-postgis`, which the PG18
   service runs, is a public package. Do the same here: github.com/orgs/boardsesh →
   Packages → `boardsesh-clickhouse` → Package settings → Danger Zone → Change
   visibility → Public. It holds no secrets, only stock ClickHouse and two config
   files. Check it from a shell that is logged out of ghcr.io:
   `docker manifest inspect ghcr.io/boardsesh/boardsesh-clickhouse@sha256:…` prints
   a manifest instead of `unauthorized`.
3. **Pin it.** Put the digest reference from step 1 in `CLICKHOUSE_IMAGE` in
   `infra/railway/config.ts` and merge that PR on its own. The `apply` job deploys
   ClickHouse alone, waits for it, then probes the OTA server's `/hc` and `/ready`:
   xprem is the client that has to reach ClickHouse, so its readiness is the real
   check. A failed probe rolls ClickHouse back. The planner refuses a run that would
   change the ClickHouse and OTA images together, so the rule below cannot be broken
   by one merge. Without CI, the manual path is Railway → `boardsesh-ota-clickhouse`
   → Settings → Source → Docker Image, then the same constant change so the nightly
   drift check agrees.
4. **Bound the container.** ClickHouse caps itself at 1.2 GB; the 2 GB container limit
   is the safety rail behind it (the server takes the lower of its setting and 90% of
   the cgroup, so the 1.2 GB setting stays in force):

   ```sh
   railway environment edit --project afceee45-0af1-46b3-abbe-8b9094c23bc6 --environment production --message 'ClickHouse: lean image, 2 GB / 2 vCPU ceiling' <<'JSON'
   {"services":{"fbed6e0a-ed08-485c-b2f3-3cd879732d69":{"deploy":{"limitOverride":{"containers":{"cpu":2,"memoryBytes":2000000000}}}}}}
   JSON
   ```

5. **Deploy ClickHouse only.** The apply job already did this when it pinned the
   image; step 4's limit change stages a second deploy for ClickHouse alone. Do not
   touch the OTA server. Then check `https://updates.boardsesh.com/hc` still answers
   200 and the Observe dashboard still renders its charts.
6. **Drop the old log tables.** Removing a log from config stops ClickHouse writing
   it, but the tables already on the volume stay until dropped. Create a temporary
   Railway TCP proxy to port 8123 on `boardsesh-ota-clickhouse`, then list what is
   left and drop it:

   ```sh
   CH='https://<proxy-host>:<proxy-port>'   # plain http:// if the proxy is not TLS
   AUTH='--user xprem:<CLICKHOUSE_PASSWORD from the service variables>'
   curl -sS $AUTH "$CH" --data-binary "SELECT name FROM system.tables
     WHERE database = 'system' AND engine = 'MergeTree' AND name != 'query_log'"
   # For each name printed (asynchronous_metric_log, metric_log, trace_log, part_log,
   # text_log, query_log_0 if the TTL change renamed the old query_log, …):
   curl -sS $AUTH "$CH" --data-binary 'DROP TABLE system.asynchronous_metric_log SYNC'
   ```

   Delete the TCP proxy afterwards. It exposes the database to the internet for as
   long as it exists. Run the listing again after any future base-version bump: a
   version whose `query_log` schema differs renames the old table to `query_log_N`
   the same way, and nothing drops it.
7. **Verify over 24 hours.** Railway memory for the service stays under 1.2 GB, the
   volume reading printed by `vp run railway:apply` drops, and the dry run reports no
   drift.

Rollback: revert the `CLICKHOUSE_IMAGE` PR (or set it to the previous digest) and
merge; the apply job deploys ClickHouse alone. In an emergency, repoint Source →
Docker Image at `clickhouse/clickhouse-server:25.3` by hand, deploy ClickHouse alone,
and follow up with the constant change so the drift check stops reporting it. The volume and the `expo_observe` data are untouched by
either image; stock config recreates the dropped log tables, empty.

## Why services are not created

A ClickHouse service is only correct with a persistent volume mounted at
`/var/lib/clickhouse`. A service created without one looks perfectly healthy and
loses every row on each redeploy, and a name lookup that misses would create a
*second* service rather than reusing the first. Neither has a cheap undo.

A project-level service also needs an instance in the selected environment. A
missing environment instance is blocked drift, not an in-sync result. The tool
does not create it or write its variables/settings or trigger its deployment;
restore the intended instance and any persistent mount first.

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

The `apply` job gets a concurrency group of its own, and never cancels. Keying on
`github.ref` alone would not achieve that: it is `refs/heads/main` for push,
schedule and `workflow_dispatch` alike, so all three would share one group — and
`cancel-in-progress` is read from the *incoming* run. The 06:30 cron landing on an
apply that merged at 06:29 would have killed it mid-deploy. A dry-run alongside an
apply is harmless, so the read-only runs share a separate, cancellable group.

`timeout-minutes` sits above the tool's own worst case for the same reason: the poll
budgets 15 minutes and the rollback another 15, so a shorter job timeout could kill
the rollback halfway.

> **`RAILWAY_TOKEN`'s blast radius grew.** The same credential that used to read,
> and write one variable it was handed, can now roll a container image. That is a
> real widening even behind `--allow-image-change`, and worth remembering when
> deciding where that secret lives.

## Env

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAILWAY_TOKEN` | yes | Railway API token. The same secret the production deploy already uses against `backboard.railway.com`. It is a **project** token, scoped to this project and its production environment, so it authenticates with `Project-Access-Token` — not `Authorization: Bearer`, which is for account tokens. The script tries one and falls back to the other, so either kind works — but the rollback path needs a project token specifically, since it derives its scope from `projectToken`. |
| `RAILWAY_PROJECT_ID` | yes | The project holding the OTA services. |
| `RAILWAY_VAR_<NAME>` | no | A value `--apply` may write for a presence-only variable. Never logged. |
| `CLICKHOUSE_URL` | no | Enables the retention assertion. Read-only. **Do not add this as a CI secret yet** — see the reachability note under ClickHouse retention. |

## Related

- [mobile-ota-updates.md](./mobile-ota-updates.md) — the OTA server itself: hosting,
  versions, the publish path, and the cutover history.
- [cloudflare.md](./cloudflare.md) — the same config-as-code pattern for the
  `boardsesh.com` zone.
- [production-deploy.md](./production-deploy.md) — the web/backend deploy path, and
  why `drainingSeconds` exists.
