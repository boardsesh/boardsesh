# Scheduler service (`packages/scheduler`)

A long-lived Node container that fires Boardsesh's scheduled jobs. Part of the
Phase 0a hosting move (#1859 → #1860 → #1874). Since #4654 it owns **every**
cron: `packages/web/vercel.json` no longer declares a `crons` key.

## What it is (and isn't)

The scheduler **triggers** existing `/api/internal/*` routes over HTTP with
`Authorization: Bearer $CRON_SECRET`. It does not reimplement the jobs.

That's not laziness — two of the three job families can't run outside Next:

- `prewarm-heatmap` warms `cachedGetHoldHeatmapData`, a Next cache entry whose
  key has to match a real first-visit request byte for byte.
- `profile-percentiles` ends with `revalidateTag(USER_CLIMB_PERCENTILE_CACHE_TAG)`.

Neither is reachable from a plain Node process, so the routes stay the single
implementation and only the trigger moves.

## Job ownership

All eight jobs. `packages/scheduler/src/__tests__/registry.test.ts` pins each
row's path and slot as data, and asserts `packages/web/vercel.json` declares no
`crons` key at all — so a schedule reappearing there (which would double-fire
the route, Vercel and Railway both) reds CI.

| Job                          | Path                                        | Schedule (UTC) | `timeoutMs` | Sentry monitor slug                    |
| ---------------------------- | ------------------------------------------- | -------------- | ----------- | -------------------------------------- |
| `cleanup`                    | `/api/internal/cleanup`                     | `0 5 * * *`    | 120 s       | `scheduler-cleanup`                    |
| `prewarm-heatmap-kilter`     | `/api/internal/prewarm-heatmap/kilter`      | `0 4 * * 0`    | 15 min      | `scheduler-prewarm-heatmap-kilter`     |
| `prewarm-heatmap-tension`    | `/api/internal/prewarm-heatmap/tension`     | `15 4 * * 0`   | 15 min      | `scheduler-prewarm-heatmap-tension`    |
| `prewarm-heatmap-decoy`      | `/api/internal/prewarm-heatmap/decoy`       | `30 4 * * 0`   | 15 min      | `scheduler-prewarm-heatmap-decoy`      |
| `prewarm-heatmap-touchstone` | `/api/internal/prewarm-heatmap/touchstone`  | `45 4 * * 0`   | 15 min      | `scheduler-prewarm-heatmap-touchstone` |
| `prewarm-heatmap-grasshopper`| `/api/internal/prewarm-heatmap/grasshopper` | `0 5 * * 0`    | 15 min      | `scheduler-prewarm-heatmap-grasshopper`|
| `profile-percentiles`        | `/api/internal/profile-percentiles`         | `0 6 * * 0`    | 15 min      | `scheduler-profile-percentiles`        |
| `refresh-sitemap-climbs`     | `/api/internal/refresh-sitemap-climbs`      | `0 */6 * * *`  | 15 min      | `scheduler-refresh-sitemap-climbs`     |

**The 15-minute stagger between the prewarms is a rate limit, not cosmetics.**
Each one fans out heatmap aggregates against the same Postgres; collapsing them
onto one minute puts five boards' worth of that load on the database at once.

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

**Why 15 minutes and not 300 seconds.** Both weekly routes still export
`maxDuration = 300`. That number was never a measurement — it is Vercel's Pro
ceiling, the largest value the platform accepts. A container has no such
ceiling, so the scheduler grants the headroom the work actually wanted. While
web still serves from Vercel the route's own limit bites first and the scheduler
just observes the 504; once web moves to Railway the export goes inert and the
scheduler's `timeoutMs` becomes the only bound.

`packages/web/vercel.json` itself stays until the Phase 4 scrub; it is not
deleted now that the last cron has left it.

### Not in scope

- The GitHub-Actions-scheduled jobs (`refresh-recommendations`,
  `refresh-climb-grades`, `refresh-content-model`, `refresh-hold-features`,
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
| `CRON_SECRET`             | yes      | —                           | **Copy** the Vercel project value, don't regenerate: the web routes still validate against the secret in their own environment. Rotating it means updating both places at once. |
| `BOARDSESH_WEB_URL`       | no       | `https://www.boardsesh.com` | Same env name the backend uses (`packages/backend/src/lib/web-revalidate.ts`).                                                                                     |
| `PORT`                    | no       | `8080`                      | Health server.                                                                                                                                                     |
| `SCHEDULER_DISABLED_JOBS` | no       | —                           | Comma-separated job names to leave unscheduled. Read once at startup, so set it and restart the service — no code change, no image rebuild. `run <job>` still works on a disabled job. |
| `SENTRY_DSN`              | no       | —                           | Turns on the cron monitors below. Use the **same DSN `packages/web` uses server-side** — it is the literal in `packages/web/sentry.server.config.ts`, also the fallback in `packages/backend/src/instrument.ts`. Unset = monitors off, logged once at startup. |
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
   - `SENTRY_DSN` — the web server DSN, for the cron monitors.
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
each `prewarm-heatmap` writes the same cache entry twice, `profile-percentiles`
is an idempotent recompute-and-upsert, and `refresh-sitemap-climbs` declines the
second writer on its advisory lock.

Merging before the Railway service runs the new image pauses the job instead.
Consequences, in order of how long you can ignore them:

- `cleanup` — 180-day feed-item and 90-day notification retention pauses.
  Delete-by-age, so it catches up on its next run. Harmless for weeks.
- `prewarm-heatmap-*` — the first visitor to each board/angle pays the cold
  query instead of hitting a warm cache. Slow, not broken.
- `profile-percentiles` — the "top N%" figure on profiles goes a week stale.
- `refresh-sitemap-climbs` — the climb sitemap store's `<lastmod>` values drift.
  The `after()` self-heal on `/sitemap.xml` still repopulates a missing or 48-h-old
  store on the next crawl, so this one degrades to "slower to notice new climbs"
  rather than to a broken sitemap.

None of these are data loss, but the Sentry monitors will (correctly) raise a
missed-occurrence issue for each one, which is the signal to finish the cutover.

## Sentry cron monitors (#1876)

`/health/jobs` tells you a job **failed**. It cannot tell you a job never
**ran** — a dead container, a wrong `TZ`, a stopped ticker all produce silence,
and silence looks identical to "nothing was due". That gap is what the monitors
close, and it is why `automaticVercelMonitors` had to be replaced rather than
just switched off: it only ever worked because Vercel handed Sentry the cron
metadata out of a deploy, which no longer happens.

Every **scheduled** run is wrapped in `Sentry.withMonitor(slug, run, config)`
(`packages/scheduler/src/monitoring/`). The config carries the job's own crontab
expression and UTC timezone, so Sentry knows when the next check-in is due and
raises an issue when one does not arrive:

- `checkinMargin: 5` minutes late before an occurrence counts as missed —
  enough to ride out a Railway deploy swap, well inside the 15-minute prewarm
  stagger.
- `maxRuntime` = the job's `timeoutMs` rounded up to minutes, plus one.
- `failureIssueThreshold: 1`, `recoveryThreshold: 1`. These jobs are weekly;
  waiting for a second consecutive failure means hearing about a broken prewarm
  a fortnight late.

Sentry creates each monitor from its first check-in — there is nothing to
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
  whenever the process is up. It deliberately stays green on a failing job:
  restarting the container cannot fix a rotated `CRON_SECRET` or a WAF rule,
  and a restart would wipe the `lastError` that tells you which it is. The body
  still carries `status: 'degraded'` and `degraded: true`.
- `GET /health/jobs` — **job health**. 503 when a scheduled job's last run
  failed, 200 otherwise. Point an alert here. Do **not** point Railway's
  healthcheck at it.

## Runbook

**Is it ticking?** `GET /health` returns every job with `lastRunAt`,
`lastSuccessAt`, `lastDurationMs`, `lastError`, `runCount`, `failureCount` and
`skippedCount`. `lastRunAt` older than the job's interval means the ticker is
not firing; check the container is actually running and its clock is sane.

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
and restart — no code change, no redeploy. Note that a disabled job stops
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
