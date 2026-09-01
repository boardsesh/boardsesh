# @boardsesh/scheduler

Long-lived cron service that fires Boardsesh's scheduled jobs. Replaces the
Vercel `crons` entries in `packages/web/vercel.json`, one job at a time.

It is a **trigger, not a reimplementation**: each job makes an HTTP request to
the existing `/api/internal/*` route with `Authorization: Bearer $CRON_SECRET`
— the exact header `requireCronAuth` already validates. Several of those routes
touch Next-only primitives (`unstable_cache` warm-up, `revalidateTag`) that a
plain Node process cannot reach, so the routes stay the single implementation.

## Commands

Locally, from the repo root:

```bash
vp exec tsx packages/scheduler/src/cli/index.ts start       # cron loop + /health server
vp exec tsx packages/scheduler/src/cli/index.ts run cleanup # one-shot, exits non-zero on failure
vp exec tsx packages/scheduler/src/cli/index.ts list        # registered jobs and schedules
```

Inside the `boardsesh-sync` image (Railway start command, one-off runs) there is
no `vp`, so use the form `Dockerfile.sync` documents:

```bash
node --import tsx packages/scheduler/src/cli/index.ts start
node --import tsx packages/scheduler/src/cli/index.ts run cleanup
```

## Environment

| Variable                  | Required | Default                     | Notes                                                                                                |
| ------------------------- | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CRON_SECRET`             | yes      | —                           | Same value as the Vercel project env var. Not renamed; see `packages/web/app/lib/auth/cron-auth.ts`. |
| `BOARDSESH_WEB_URL`       | no       | `https://www.boardsesh.com` | Same name the backend uses for web callbacks.                                                        |
| `PORT`                    | no       | `8080`                      | Health server port (`GET /health` liveness, `GET /health/jobs` job health).                          |
| `SCHEDULER_DISABLED_JOBS` | no       | —                           | Comma-separated job names to leave unscheduled. `run <job>` still works.                             |

A missing `CRON_SECRET` throws at startup, not on the first tick.

## Adding a job

1. Add a `JobDefinition` to `src/jobs/registry.ts` with an explicit
   `timezone: 'UTC'` — Vercel crons are UTC, a container's local zone is not
   guaranteed to be, and UTC has no DST gap for a schedule to fall into.
2. Remove the matching entry from `packages/web/vercel.json` and from
   `VERCEL_OWNED_CRON_PATHS`. `src/__tests__/registry.test.ts` diffs both sides,
   so editing only one fails CI.
3. Deploy the scheduler and confirm a manual `run <job>` returns 200 in
   production **before** merging the `vercel.json` removal.

Ownership table, Railway setup and the runbook live in `docs/scheduler.md`.

## Cron support

`src/cron/` implements the five standard numeric fields
(`minute hour day-of-month month day-of-week`) with `*`, `a`, `a-b`, lists and
`/step`, evaluated once a minute in each job's declared IANA timezone. Month and
weekday names, `@daily` shorthands, seconds and Quartz extensions (`L`, `W`,
`#`) throw at parse time rather than being silently reinterpreted.
