# Scheduler service (`packages/scheduler`)

A long-lived Node container that fires Boardsesh's scheduled jobs, taking them
off Vercel crons one at a time. Part of the Phase 0a hosting move (#1859 →
#1860 → #1874).

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

Update this table as each job migrates. `packages/scheduler/src/__tests__/registry.test.ts`
diffs the "Vercel" rows against `packages/web/vercel.json` and fails if the two
sides drift, so a job can't end up double-scheduled or unscheduled.

| Path                                        | Schedule (UTC) | Runs on                       |
| ------------------------------------------- | -------------- | ----------------------------- |
| `/api/internal/cleanup`                     | `0 5 * * *`    | **Scheduler** (job `cleanup`) |
| `/api/internal/prewarm-heatmap/kilter`      | `0 4 * * 0`    | Vercel cron                   |
| `/api/internal/prewarm-heatmap/tension`     | `15 4 * * 0`   | Vercel cron                   |
| `/api/internal/prewarm-heatmap/decoy`       | `30 4 * * 0`   | Vercel cron                   |
| `/api/internal/prewarm-heatmap/touchstone`  | `45 4 * * 0`   | Vercel cron                   |
| `/api/internal/prewarm-heatmap/grasshopper` | `0 5 * * 0`    | Vercel cron                   |
| `/api/internal/profile-percentiles`         | `0 6 * * 0`    | Vercel cron                   |

`packages/web/vercel.json` itself stays until the Phase 1 cutover; it is not
deleted when the last cron leaves it.

The GitHub-Actions-scheduled jobs (`refresh-recommendations`,
`refresh-climb-grades`, `refresh-content-model`, `refresh-hold-features`,
`export-board-snapshots`, `refresh-acknowledgements`) are a separate thing and
are not in scope here.

## Environment

| Variable                  | Required | Default                     | Notes                                                                                                                                                              |
| ------------------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CRON_SECRET`             | yes      | —                           | **Copy** the Vercel project value, don't regenerate: the remaining Vercel crons authenticate with the same secret. Rotating it means updating both places at once. |
| `BOARDSESH_WEB_URL`       | no       | `https://www.boardsesh.com` | Same env name the backend uses (`packages/backend/src/lib/web-revalidate.ts`).                                                                                     |
| `PORT`                    | no       | `8080`                      | Health server.                                                                                                                                                     |
| `SCHEDULER_DISABLED_JOBS` | no       | —                           | Comma-separated job names to leave unscheduled — an env-flip kill switch, no redeploy needed. `run <job>` still works on a disabled job.                           |

A missing `CRON_SECRET` throws at startup, so a misconfigured service
crash-loops loudly instead of 401ing quietly at 05:00.

## Railway service setup

The scheduler ships inside the existing combined `boardsesh-sync` image —
`Dockerfile.sync` already runs any CLI via `tsx`, and
`.github/workflows/sync-deploy.yml` already rebuilds on `packages/**`. No new
Dockerfile, no new workflow.

1. **New service** in the Boardsesh Railway project, name it `scheduler`.
2. **Source → Docker Image**: `ghcr.io/boardsesh/boardsesh-sync:production`.
3. **Custom start command**: `bunx tsx packages/scheduler/src/cli/index.ts start`
4. **Variables**:
   - `CRON_SECRET` — same value as the Vercel project env var.
   - `BOARDSESH_WEB_URL=https://www.boardsesh.com`
   - `PORT=8080` (or let Railway inject its own `PORT`).
5. **Healthcheck path**: `/health`.
6. **Replicas: 1.** Two instances would double-fire every job; there is no
   leader election in this slice. If it ever needs more than one, `DaemonLease`
   in `packages/sync-runtime` is the existing Postgres-backed tool.

## Cutover order (matters)

Do it in this order, or cleanup silently stops running:

1. Deploy the Railway service with the env above.
2. Shell into it (or use a one-off run) and confirm a manual trigger works
   against production:
   `bunx tsx packages/scheduler/src/cli/index.ts run cleanup`
   It must print the route's JSON and exit 0. **This is the step that catches a
   Vercel WAF / bot rule blocking Railway egress IPs** — nothing local can.
3. Only then merge the PR that drops the entry from `packages/web/vercel.json`.

Between steps 1 and 3 both schedulers may fire the job. That's safe:
`/api/internal/cleanup` deletes rows older than a fixed age in deadline-bounded
batches, so a double run is a no-op on the second pass.

If the PR merges before the service exists, the 180-day feed-item and 90-day
notification retention pauses. Harmless for weeks — the job is delete-by-age
and catches up on its next run — but it should not be left that way.

## Runbook

**Is it ticking?** `GET /health` returns every job with `lastRunAt`,
`lastSuccessAt`, `lastDurationMs`, `lastError`, `runCount`, `failureCount` and
`skippedCount`. `lastRunAt` older than the job's interval means the ticker is
not firing; check the container is actually running and its clock is sane.

**A job is failing.** `lastError` carries the HTTP status and a truncated body.
401 → the two `CRON_SECRET`s have drifted apart. 403 with an HTML body → a
Vercel WAF/bot rule is blocking Railway egress. 5xx → the route itself; look at
the web logs.

**A job is stuck.** A tick whose predecessor is still in flight is skipped and
warned, never queued, so a slow run can't stack up. Each run is also bounded by
the job's `timeoutMs` (120s for `cleanup`) via `AbortController`. If a job is
misbehaving, set `SCHEDULER_DISABLED_JOBS=<name>` and restart — no code change,
no redeploy.

**Run one now.** `bunx tsx packages/scheduler/src/cli/index.ts run <job>` runs a
single job and exits non-zero on failure. It never starts the recurring
schedule, and it works on a job held back by `SCHEDULER_DISABLED_JOBS`.

## Follow-ups

- One PR per remaining job (`profile-percentiles`, then the five
  `prewarm-heatmap` boards), each moving one row in the table above.
- Sentry cron monitors around job runs (#1876). The runner already records
  `lastError` and logs failures, so the hook-up point exists.
- A dedicated `Dockerfile.scheduler` + `scheduler-deploy.yml` +
  `boardsesh-scheduler` image, if the scheduler should release on its own
  cadence instead of riding the sync image. Mechanical, but a second PR's worth
  of workflow wiring.
