# Scheduler service (`packages/scheduler`)

A long-lived Node container that fires Boardsesh's scheduled jobs. Part of the
Phase 0a hosting move (#1859 → #1860 → #1874). Since #4654 it owns **every**
cron: `packages/web/vercel.json` no longer declares a `crons` key.

## What it is (and isn't)

The scheduler triggers web `/api/internal/*` routes and the backend's
`refreshGymActivityStats` GraphQL mutation over HTTP with
`Authorization: Bearer $CRON_SECRET`. Job implementations stay in their owning service.

That's not laziness: `profile-percentiles` ends with
`revalidateTag(USER_CLIMB_PERCENTILE_CACHE_TAG)`, which is not reachable from a
plain Node process, so the routes stay the single implementation and only the
trigger moves.

The five weekly `prewarm-heatmap-*` jobs are gone: the web hold-heatmap route
they warmed was retired, and hold heatmaps now run on the climber's downloaded
board in the app. Their Sentry monitors (`scheduler-prewarm-heatmap-*`) get no
more check-ins; delete them in Sentry after the deploy, or each one raises a
missed-occurrence issue.

## Job ownership

All five jobs. `packages/scheduler/src/__tests__/registry.test.ts` pins each
row's path and slot as data, and asserts `packages/web/vercel.json` declares no
`crons` key at all — so a schedule reappearing there (which would double-fire
the route, Vercel and Railway both) reds CI.

| Job                          | Path                                        | Schedule (UTC) | `timeoutMs` | Sentry monitor slug                    |
| ---------------------------- | ------------------------------------------- | -------------- | ----------- | -------------------------------------- |
| `cleanup`                    | `/api/internal/cleanup`                     | `0 5 * * *`    | 120 s       | — (`overdue` on `/health/jobs`)        |
| `profile-percentiles`        | `/api/internal/profile-percentiles`         | `0 6 * * 0`    | 15 min      | — (`overdue` on `/health/jobs`)        |
| `refresh-sitemap-climbs`     | `/api/internal/refresh-sitemap-climbs`      | `0 */6 * * *`  | 15 min      | `scheduler-refresh-sitemap-climbs`     |
| `refresh-gym-activity-stats` | Backend `/graphql`: `refreshGymActivityStats` | `30 6 * * *` | 15 min | — (`overdue` on `/health/jobs`)        |
| `purge-spray-wall-photos`    | Backend `/graphql`: `purgeDeletedSprayWallPhotos` | `0 7 * * *` | 10 min | — (`overdue` on `/health/jobs`)        |

**`refresh-sitemap-climbs` is the one job that missed the migration.** Vercel
fired it at `0 */6 * * *` from 2026-08-22 until the climb-sitemap pause deleted
the row on 2026-08-29 (`git show 98ef8e32b -- packages/web/vercel.json`), so by
the time #4654 moved the crons across there was nothing left to move. #4648
republishes the surface and brings the same slot back here — which is why it
sits in `registry.test.ts`'s one pinned list with the rest: the slot really is
the slot Vercel ran. It is overlap-safe the way `JobDefinition` requires: the
refresher takes `pg_try_advisory_xact_lock` as the first statement of its write
transaction, so a second run that meets a first in flight answers
`skipped: "locked"` and writes nothing. See [sitemap.md](./sitemap.md).

`refresh-gym-activity-stats` rebuilds the per-gym activity cache daily at
06:30 UTC through the GraphQL backend. The backend acquires a transaction-scoped
advisory lock before reading either guard input; counts and writes share a
repeatable-read snapshot. Both queries exclude deleted gyms and private,
unlisted, or deleted boards. This is intentional: historical events contribute
only while their board is currently eligible for the public gym ranking.
Deleting a board can therefore reduce all-time counts.

Empty results, drops greater than 50%, and lock contention return HTTP 409
with GraphQL error code `CONFLICT` and `extensions.skipped` set to `empty`,
`shrank`, or `locked`. The scheduler treats both non-2xx responses and GraphQL
errors inside HTTP 200 as failed runs. It retries only HTTP 502/503 once after
two seconds. GraphQL `force: true` permits a nonempty shrink; it never bypasses
authentication or the lock. Cron credentials do not grant user or WebSocket access.

Successful responses and backend logs expose `scanDurationMs` (guard counts),
`writeDurationMs` (cache rebuild), and `durationMs` (whole operation including
lock acquisition and commit). Failed-run logs also carry these timings.

### Spray wall photo retention

`purge-spray-wall-photos` deletes the photographs of spray walls their owners
soft-deleted more than 30 days ago (`SPRAY_WALL_PHOTO_RETENTION_DAYS`; see
[spray-walls.md](./spray-walls.md) → "Retention"). 07:00 UTC, half an hour after
the gym activity rebuild so the two daily jobs never share a tick.

Like `refresh-gym-activity-stats`, the work is a cron-authenticated backend
mutation and the job holds only the schedule: the scheduler has no database
client and no storage credentials, and giving it either would put the private
photo bucket behind a second service. Same failure handling — a non-2xx or
GraphQL errors inside an HTTP 200 are both a failed run, and only 502/503 is
retried once after two seconds, because those are "a deploy is in flight" rather
than "the server said no".

It is overlap-safe the way `JobDefinition` requires, without a lock: the mutation
deletes objects and then clears `photo_key`, so a second run meeting a first
re-lists prefixes that are already empty, deletes nothing twice, and never fails
on a missing object. One wall's storage failure is logged and skipped rather than
failing the batch; the next run picks it up.

Ten minutes rather than the 15 the long jobs get. Nothing here scans a large
table — the candidate query is an index read on the partial index
`spray_walls_deleted_at_idx` (`WHERE deleted_at IS NOT NULL`), batched at 200
walls — so the bound is object-storage latency, and a wedged endpoint should not
hold a worker until the next day's tick.

Manual run: `scheduler run purge-spray-wall-photos`, or POST to the backend
`/graphql` with `Authorization: Bearer $CRON_SECRET`:

```json
{"query":"mutation { purgeDeletedSprayWallPhotos { wallsPurged objectsDeleted wallsConsidered durationMs } }"}
```

`wallsConsidered` is how many walls past the window still had a photo key when
the run started, so a run that reports `wallsPurged: 0, wallsConsidered: 0` has
nothing to do — not a failure.

### Gym activity backend cutover

Deploy the backend with the scheduler's existing `CRON_SECRET` before deploying
the scheduler change. The scheduler's `BOARDSESH_BACKEND_GRAPHQL_URL` defaults
to `https://ws.boardsesh.com/graphql`; set an explicit endpoint for local or
preview runs. Verify a manual GraphQL refresh succeeds before enabling the
new scheduler image. The old Next.js refresh route is removed; deployments
must switch the scheduler before deploying that web removal. If those deploys
cannot be ordered, temporarily disable `refresh-gym-activity-stats` through
`SCHEDULER_DISABLED_JOBS`, then re-enable it after the cutover.

For a forced manual refresh, POST this JSON to the backend `/graphql` endpoint
with `Content-Type: application/json` and `Authorization: Bearer $CRON_SECRET`:

```json
{"query":"mutation { refreshGymActivityStats(force: true) { gymCount previousGymCount scanDurationMs writeDurationMs durationMs timestamp } }"}
```

**Why 15 minutes and not 300 seconds.** Both weekly routes still export
`maxDuration = 300`. That number was never a measurement — it is Vercel's Pro
ceiling, the largest value the platform accepts. A container has no such
ceiling, so the scheduler grants the headroom the work actually wanted. While
web still serves from Vercel the route's own limit bites first and the scheduler
just observes the 504; once web moves to Railway the export goes inert and the
scheduler's `timeoutMs` becomes the only bound.

`packages/web/vercel.json` itself stays until the Phase 4 scrub; it is not
deleted now that the last cron has left it.

### GitHub Actions acknowledgement refresh

`refresh-acknowledgements.yml` remains a GitHub Actions job because it reads
GitHub contributors and Sponsors, then commits the bundled mobile snapshot.
It runs each Monday at 07:00 UTC and uses the Boardsesh Repo Bot installation
token for both the GraphQL requests and its protected-`main` commit. The App
needs repository Contents: write plus Organization Members: read; the latter
authorizes `sponsorshipsAsMaintainer`, including the private-sponsor total.

The job runs the acknowledgement generator in strict mode. A missing GitHub
source, malformed GraphQL response, or unavailable private-sponsor count fails
the run before the committed snapshot changes. Successful and failed runs post
their outcome to the deployments Discord channel through the Production-scoped
`DISCORD_DEPLOY_WEBHOOK` secret. The legacy `ACKNOWLEDGEMENTS_GH_TOKEN` remains
unused and may be retained until its normal secret-rotation review.

### Not in scope

- The GitHub-Actions-scheduled jobs (`refresh-recommendations`,
  `refresh-climb-grades`, `refresh-climb-neighbors`, `refresh-content-model`, `refresh-hold-features`,
  `export-board-snapshots`, `refresh-acknowledgements`) are a separate thing.
- **`user-sync-cron` (#1875) needs no decision — the route is gone.**
  `git grep user-sync-cron` returns only three prose mentions
  (`docs/aurora-sync.md` ×2, `docs/branch-deploys.md`), all describing its
  removal. `/api/internal/user-sync-cron` and the backend's `POST /sync-cron`
  were both retired in favour of the long-lived aurora/kilter sync daemons,
  which loop internally and hold their cooldowns in Postgres. There is nothing
  to register here, and nothing silently drops off the schedule at cutover.

**Keep new jobs on UTC.** Every job declares its own IANA zone, and the ticker
honours it — but UTC has no DST gaps. A job scheduled inside a spring-forward
gap (say 02:30 `America/New_York`) simply does not run that day, because that
wall-clock minute doesn't exist; fall-back is safe and runs once, not twice.
That's standard crontab behaviour, and the reason the registry pins everything
to UTC.

## Environment

| Variable                  | Required | Default                     | Notes                                                                                                                                                              |
| ------------------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CRON_SECRET`             | yes      | —                           | Share the existing value across scheduler, web, and backend. Rotate it in all three environments together. |
| `BOARDSESH_WEB_URL`       | no       | `https://www.boardsesh.com` | Same env name the backend uses (`packages/backend/src/lib/web-revalidate.ts`).                                                                                     |
| `BOARDSESH_BACKEND_GRAPHQL_URL` | no | `https://ws.boardsesh.com/graphql` | Full HTTP(S) endpoint for the backend-owned gym activity job. |
| `PORT`                    | no       | `8080`                      | Health server.                                                                                                                                                     |
| `SCHEDULER_DISABLED_JOBS` | no       | —                           | Comma-separated job names to leave unscheduled. Read once at startup, so set it and restart the service — no code change, no image rebuild. `run <job>` still works on a disabled job. |
| `SENTRY_DSN`              | no       | —                           | Turns on the `refresh-sitemap-climbs` cron monitor below. Use the **same DSN `packages/web` uses server-side** — it is the literal in `packages/web/sentry.server.config.ts`, also the fallback in `packages/backend/src/instrument.ts`. Unset = monitors off, logged once at startup. |
| `SENTRY_ENVIRONMENT`      | no       | `production`                | Environment tag on the check-ins.                                                                                                                                                  |

A missing `CRON_SECRET` throws at startup, so a misconfigured service
crash-loops loudly instead of 401ing quietly at 05:00.

Unlike web and backend, the scheduler has **no hardcoded DSN fallback**. The
same CLI is what an operator runs by hand against production
(`scheduler run cleanup`), and a baked-in DSN would file that laptop's output
against the production project.

## Railway service setup

The scheduler ships inside the existing combined `boardsesh-sync` image —
`Dockerfile.sync` already runs any CLI via `tsx`, and
`.github/workflows/sync-deploy.yml` already rebuilds on `packages/**`. No new
Dockerfile, no new workflow.

1. **New service** in the Boardsesh Railway project, name it `scheduler`.
2. **Source → Docker Image**: `ghcr.io/boardsesh/boardsesh-sync:production`.
3. **Custom start command**:
   `node --import tsx packages/scheduler/src/cli/index.ts start`
   — the same shape `Dockerfile.sync` documents for the sync daemons. The image
   ships Node and `tsx`; it has no `vp`, and nothing in this repo runs on Bun.
4. **Variables**:
   - `CRON_SECRET` — same value as the Vercel project env var.
   - `BOARDSESH_WEB_URL=https://www.boardsesh.com`
   - `PORT=8080` (or let Railway inject its own `PORT`).
   - `SENTRY_DSN` — the web server DSN, for the `refresh-sitemap-climbs` cron monitor.
5. **Healthcheck path**: `/health`.
6. **Replicas: 1.** Two instances would double-fire every job; there is no
   leader election in this slice. If it ever needs more than one, `DaemonLease`
   in `packages/sync-runtime` is the existing Postgres-backed tool.

## Cutover order (matters)

Do it in this order, or the job silently stops running:

1. Deploy the Railway service with the env above.
2. Shell into it (or use a one-off run) and confirm a manual trigger works
   against production:
   `node --import tsx packages/scheduler/src/cli/index.ts run cleanup`
   It must print the route's JSON and exit 0. **This is the step that catches a
   Vercel WAF / bot rule blocking Railway egress IPs** — nothing local can.
3. Only then merge the PR that drops the entry from `packages/web/vercel.json`.

Between steps 1 and 3 both schedulers may fire the job. That is safe for every
job: `cleanup` deletes rows older than a fixed age in deadline-bounded batches,
`profile-percentiles`
is an idempotent recompute-and-upsert, and `refresh-sitemap-climbs` declines the
second writer on its advisory lock.

Merging before the Railway service runs the new image pauses the job instead.
Consequences, in order of how long you can ignore them:

- `cleanup` — 180-day feed-item and 90-day notification retention pauses.
  Delete-by-age, so it catches up on its next run. Harmless for weeks.
- `profile-percentiles` — the "top N%" figure on profiles goes a week stale.
- `refresh-sitemap-climbs` — the climb sitemap store's `<lastmod>` values drift.
  The `after()` self-heal on `/sitemap.xml` still repopulates a missing or 48-h-old
  store on the next crawl, so this one degrades to "slower to notice new climbs"
  rather than to a broken sitemap.

None of these are data loss, but `/health/jobs` will (correctly) go 503 with
each one `overdue`, and the `refresh-sitemap-climbs` Sentry monitor raises a
missed-occurrence issue — the signal to finish the cutover.

## Sentry cron monitors (#1876)

A failing job is easy to see. A job that never **runs** is not — a dead
container, a wrong `TZ`, a stopped ticker all produce silence. Two things catch
that silence: one Sentry cron monitor, and the `overdue` flag on
`/health/jobs` (see [Health endpoints](#health-endpoints)).

**Only `refresh-sitemap-climbs` has a Sentry monitor.** Sentry bills $0.78 a
month for every cron monitor beyond the first, and bills per monitor, not per
check-in. Every job shares one ticker, so one monitor proves the ticker, the
container and its clock are alive, and the most frequent job is the cheapest
canary: a dead ticker misses a six-hourly check-in within 6 hours (plus the
5-minute margin), where the daily `cleanup` would take up to 24. A job opts in
with `sentryMonitor: true` on its `JobDefinition`; `registry.test.ts` pins
`refresh-sitemap-climbs` as the only one, so adding a second is a deliberate
billing change. The other four jobs are watched through `overdue`, which an
external probe (the homelab's Prometheus blackbox exporter) alerts on. Their
old monitors (`scheduler-cleanup`, `scheduler-profile-percentiles`,
`scheduler-refresh-gym-activity-stats`, `scheduler-purge-spray-wall-photos`)
get no more check-ins after this deploy; delete them in Sentry, or each raises
a missed-occurrence issue.

`automaticVercelMonitors` had to be replaced rather than just switched off: it
only ever worked because Vercel handed Sentry the cron metadata out of a
deploy, which no longer happens.

A monitored job's **scheduled** runs are wrapped in
`Sentry.withMonitor(slug, run, config)` (`packages/scheduler/src/monitoring/`).
The config carries the job's own crontab expression and UTC timezone, so Sentry
knows when the next check-in is due and raises an issue when one does not
arrive:

- `checkinMargin: 5` minutes late before an occurrence counts as missed —
  enough to ride out a Railway deploy swap.
- `maxRuntime` = the job's `timeoutMs` rounded up to minutes, plus one.
- `failureIssueThreshold: 1`, `recoveryThreshold: 1`. Alert on the first
  missed or failed run, clear on the first success.

Sentry creates the monitor from its first check-in — there is nothing to
provision in the dashboard. Slugs are `scheduler-<job name>` and are pinned in
`cron-monitor.test.ts`, because Sentry keys a monitor's whole history on its
slug: renaming a job would orphan the old monitor and start a blank one.

Two paths deliberately send **no** check-in:

- `scheduler run <job>`. A manual run is not a scheduled occurrence; an "ok"
  from it would resolve a genuinely missed one and report a dead ticker as
  healthy.
- A tick skipped because the previous run is still in flight. It did not run, so
  letting Sentry mark the occurrence missed is the honest outcome — a job
  overrunning its own interval deserves the issue.

A failing job still fails: the monitor wrapper rethrows, so `lastError`,
`/health/jobs` and the error log all see the failure exactly as before.

## Health endpoints

Split the way the backend splits `/health` from `/health/db`:

- `GET /health` — **liveness**, and what Railway's healthcheck polls. 200
  whenever the process is up. It deliberately stays green on a failing or
  overdue job: restarting the container cannot fix a rotated `CRON_SECRET` or a
  WAF rule, and a restart would wipe the `lastError` that tells you which it is.
  The body still carries `status: 'degraded'` and `degraded: true`.
- `GET /health/jobs` — **job health**. 503 when any scheduled job's last run
  failed (`lastError` set) or is `overdue`, 200 otherwise. Point an alert here.
  Do **not** point Railway's healthcheck at it.

Each job in the body carries `expectedLastRunAt` — the most recent instant its
schedule says it should have started — and `overdue`. A job is overdue when
both hold:

1. No run has started at or after `expectedLastRunAt`. If the job has not run
   since the process started, the process start time stands in for its last
   run, so a fresh restart is never overdue for a slot that passed before it.
2. More than the job's `timeoutMs` plus 5 minutes has passed since
   `expectedLastRunAt` — `timeoutMs + 5 min`, so 7 minutes for `cleanup`, 15 for
   `purge-spray-wall-photos`, 20 for the 15-minute jobs.

Disabled jobs (`SCHEDULER_DISABLED_JOBS`) are never overdue. A tick skipped
behind a still-running predecessor does count: it did not run. It cannot flip
while that predecessor is legitimately running, because the predecessor
started before the skipped slot and is bounded by the same `timeoutMs`.

`overdue` clears when the next scheduled run starts, or when the service
restarts. A one-shot `run <job>` is a separate process, so it does **not**
clear it: after a manual catch-up run, restart the service if you want
`/health/jobs` green before the next slot.

`expectedLastRunAt` comes from walking back one minute at a time from now until
the cron expression matches (`packages/scheduler/src/cron/previous-run.ts`),
bounded at 8 days — the weekly `profile-percentiles` is the longest schedule.
A monthly job would need that bound raised to about 32 days, or it would never
read as overdue.

## Runbook

**Is it ticking?** `GET /health` returns every job with `lastRunAt`,
`lastSuccessAt`, `lastDurationMs`, `lastError`, `runCount`, `failureCount` and
`skippedCount`, plus `expectedLastRunAt` and `overdue`. `overdue: true` (and a
503 on `/health/jobs`) means a slot went by with no run; if every job is
overdue the ticker is not firing — check the container is actually running and
its clock is sane.

**A job is failing.** `lastError` carries the HTTP status and a truncated body.
401 → the two `CRON_SECRET`s have drifted apart. 403 with an HTML body → a
Vercel WAF/bot rule is blocking Railway egress. 5xx → the route itself; look at
the web logs. A 502 or 503 is retried once after 2s before it counts as a
failure (a deploy swap or a cold instance clears in seconds); 504 is not, since
the request reached the route and retrying would stack a second run on the
first. A request that never reached the app reads
`fetch failed: <cause>` — `ECONNREFUSED`/`ECONNRESET` means the connection was
refused or dropped (egress blocked at the network layer rather than by a WAF
page), `ENOTFOUND` means `BOARDSESH_WEB_URL` is wrong or DNS is broken.

**A job is stuck.** A tick whose predecessor is still in flight is skipped and
warned, never queued, so a slow run can't stack up. Each run is also bounded by
the job's `timeoutMs` (120s for `cleanup`, 15 min for the weekly jobs) via
`AbortController`. If a job is misbehaving, set `SCHEDULER_DISABLED_JOBS=<name>`
and restart — no code change, no redeploy. A disabled job drops out of
`/health/jobs`' verdict, but if it is `refresh-sitemap-climbs` it also stops
checking in, so its Sentry monitor will report missed occurrences until it is
re-enabled or the monitor is muted.

**Run one now.** `node --import tsx packages/scheduler/src/cli/index.ts run <job>` runs a
single job and exits non-zero on failure. It never starts the recurring
schedule, and it works on a job held back by `SCHEDULER_DISABLED_JOBS`.

## Follow-ups

- A dedicated `Dockerfile.scheduler` + `scheduler-deploy.yml` +
  `boardsesh-scheduler` image, if the scheduler should release on its own
  cadence instead of riding the sync image. Mechanical, but a second PR's worth
  of workflow wiring.
