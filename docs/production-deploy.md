# Production deploys: the concurrency group, and what to do when main stops shipping

`production-deploy.yml` is the only production deployer (Vercel's native git
auto-deploy is off). Every push to `main` starts a run; the run builds web and
backend in parallel, gates on both builds passing, migrates, then deploys.

## Architecture during the cut-over

www (`packages/web`) is moving off Vercel onto a Railway container (epic
#4648). While that move is in progress, production is four services, each
answering to a different platform:

| Service                       | Runs on                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| Web (`packages/web`)           | Vercel today; the Railway `web` container after the DNS flip. |
| Backend (`packages/backend`)   | Railway.                                                      |
| `app.boardsesh.com`            | Cloudflare Pages.                                              |
| Database                       | Railway PostgreSQL.                                            |

Every run of `production-deploy.yml` follows the same shape: `resolve-web-targets`
decides which web deployers this run is allowed to use, `build-web` and
`build-backend` build in parallel, the gated `migrate` job runs once every
attempted build has passed, and only then do the deploy jobs run —
`deploy-web` (Vercel), `deploy-web-railway` (Railway), and
`deploy-production-backend`. Which of the two web deploy jobs actually run is
controlled by the `WEB_DEPLOY_TARGETS` Production-environment variable — see
the table in [Web deploy targets](#web-deploy-targets) below.

## Web deploy targets

www has two possible deployers. Production traffic is on Vercel today; the
Railway `web` service (image `ghcr.io/boardsesh/boardsesh-web`, config
`railway.web.toml`) runs alongside it through the DNS flip and stays current as
the rollback for seven days after. The Production-environment variable
`WEB_DEPLOY_TARGETS` picks which ones run:

| `WEB_DEPLOY_TARGETS` | Vercel | Railway | Notes                                          |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| unset or empty       | yes    | no      | The default. Today's behaviour.                |
| `vercel`             | yes    | no      | Same, written out.                             |
| `railway`            | no     | yes     | Needs the Railway service ID and smoke origin. |
| `vercel,railway`     | yes    | yes     | Either order; whitespace and casing ignored.   |
| `none`               | no     | no      | The web hold. Discord gets `notify-web-held`.  |

Anything else — an unknown name, `none` mixed with a real target, or `railway`
while `RAILWAY_WEB_SERVICE_ID` or `RAILWAY_WEB_ORIGIN` is empty — fails
`resolve-web-targets`, which skips every web deploy and fires `notify-failure`.
It never guesses.

The GHCR image is built and pushed on **every** run regardless of the setting,
including under `none` and under an active Instant Rollback. The image is the
artifact; publishing it costs nothing and is what lets a later `railway
redeploy` promote without a rebuild.

`WEB_DEPLOY_TARGETS` is read by a job (`resolve-web-targets`) rather than by a
job-level `if:`, and that is load-bearing: a job-level `if:` is evaluated before
the environment is attached, so `vars.` there only ever sees **repository**
variables. An environment-scoped setting read that way would silently resolve to
empty.

Like every job in this workflow that reads Production-environment config,
`resolve-web-targets` declares `environment: Production` and so can park at the
environment gate the same way any other job can — see [The watchdog](#the-watchdog)
below for what that looks like and how it clears.

Production-environment config this needs:

| Name                     | Kind | Purpose                                                       |
| ------------------------ | ---- | ------------------------------------------------------------- |
| `WEB_DEPLOY_TARGETS`     | var  | The switch above. Absent is fine — it means `vercel`.          |
| `RAILWAY_WEB_SERVICE_ID` | var  | The Railway `web` service. Required before targeting railway.  |
| `RAILWAY_WEB_ORIGIN`     | var  | Origin for the post-deploy smoke. Required before targeting Railway.   |

### Single replica (web)

The Railway web service runs **exactly one replica**. Off Vercel, Next's
`unstable_cache` and `revalidateTag` are per-instance: a second replica would
serve its own divergent cache, and a `revalidateTag` on one would leave the
other stale with nothing to reconcile them. Keep it at one replica until a Redis
`cacheHandler` exists (#4658). Scale the backend horizontally instead — it is
stateless and coordinates through Redis.

## Cut-over sequence

Moving www's production traffic from Vercel to Railway happens in order, one
step at a time:

1. Set the Production-environment variable `WEB_DEPLOY_TARGETS=vercel,railway`.
   Both `deploy-web` and `deploy-web-railway` now run on every push, but Vercel
   still serves `www.boardsesh.com` — Railway is only building and shipping
   alongside it.
2. Verify the post-deploy smoke passes against `RAILWAY_WEB_ORIGIN`, the
   Railway web service's direct origin, ahead of any DNS change.
3. Flip `www.boardsesh.com` at Cloudflare to the Railway origin. Production
   traffic now serves from Railway.
4. Run dual for seven days. `WEB_DEPLOY_TARGETS` stays `vercel,railway`, so
   Vercel keeps deploying every commit and stays warm as the rollback origin
   even though it no longer receives traffic — see the rollback runbook below.
5. Scrub: delete the Vercel-specific jobs and steps from
   `production-deploy.yml` (the Vercel half of `build-web`, and `deploy-web`),
   set `WEB_DEPLOY_TARGETS=railway`, and decommission the Vercel project.

## Rollback runbook (web on Railway)

1. **Hold.** Set `WEB_DEPLOY_TARGETS=none` so further pushes to `main` stop
   shipping web images to either target while you work. The GHCR image still
   builds and pushes every run; `notify-web-held` pings Discord so the hold
   isn't silent.
2. **Dashboard rollback.** Railway → the `web` service → Deployments → pick the
   last-good deployment → Rollback. This is the same `deploymentRollback`
   GraphQL mutation the `railway-redeploy` composite action fires automatically
   when its poll ends in `FAILED`, `CRASHED`, `REMOVED`, or times out.
3. **Belt-and-braces.** If the dashboard rollback isn't enough — the bad image
   is still tagged `:production` in GHCR — retag a known-good digest and
   redeploy:
   ```
   docker pull ghcr.io/boardsesh/boardsesh-web:sha-<good>
   docker tag  ghcr.io/boardsesh/boardsesh-web:sha-<good> ghcr.io/boardsesh/boardsesh-web:production
   docker push ghcr.io/boardsesh/boardsesh-web:production
   railway redeploy --service "$RAILWAY_WEB_SERVICE_ID" --yes
   ```
4. **Fix forward.** Revert the offending commit on `main` and let CI build and
   ship the corrected image, then clear the hold.

During the seven-day dual window there's one more fallback: if Railway web is
wholly unavailable, repoint `www.boardsesh.com`'s Cloudflare origin back to
Vercel, which is still deploying every commit. That option goes away once
Vercel is decommissioned in the scrub.

## Migrations stay backward-compatible

A rollback reverts the running web image, never the database — `migrate` has
already run against the new schema and there's no down-migration. During any
redeploy window, the previous image and the new schema have to coexist, so
every migration must be additive: add columns and tables before code reads
them, keep old columns until no deployed image still references them, and
split destructive changes across releases. If a change can't be made
backward-compatible, it can't be rolled back by image alone.

## Required GitHub configuration

Web-specific config lives in the **Production** GitHub environment alongside
the backend and database secrets. This is what the workflow reads for the two
web deploy targets:

| Name                       | Kind   | Purpose                                                                          |
| --------------------------- | ------ | --------------------------------------------------------------------------------- |
| `WEB_DEPLOY_TARGETS`        | var    | Picks `vercel` / `railway` / `vercel,railway` / `none` — see the table above.    |
| `RAILWAY_WEB_SERVICE_ID`    | var    | The Railway `web` service. Required before targeting railway.                    |
| `RAILWAY_WEB_ORIGIN`        | var    | Origin for the post-deploy smoke. Required before targeting Railway.            |
| `RAILWAY_TOKEN`             | secret | Railway API token, shared with the backend redeploy through `railway-redeploy`.  |
| `NEXT_PUBLIC_WS_URL`        | var    | Backend WS URL baked into the web image and the Vercel build.                    |
| `NEXT_PUBLIC_POSTHOG_KEY`   | var    | Public PostHog key baked into the web image. Client analytics goes dark without it. |
| `SENTRY_AUTH_TOKEN`         | secret | Source-map upload during the web image build.                                    |
| `SMOKE_KIOSK_GYM_SLUG`      | var    | Fixture the post-deploy smoke reads.                                             |
| `SMOKE_EMBED_BOARD_UUID`    | var    | Fixture the post-deploy smoke reads.                                             |
| `VERCEL_TOKEN`              | secret | Still read by `build-web` and `deploy-web` until the scrub.                      |
| `VERCEL_ORG_ID`             | var    | Still read until the scrub.                                                       |
| `VERCEL_PROJECT_ID`         | var    | Still read until the scrub.                                                       |

## Why only one run moves at a time

```yaml
concurrency:
  group: production-deploy
  cancel-in-progress: false
```

One deploy at a time, and the one that is already executing is never killed —
you do not want a run cancelled between `migrate` and `deploy-web`. GitHub keeps
exactly one run queued behind the group and replaces it with each newer push, so
`detect-changes` baselines off the last **successful** deploy. The surviving run
therefore absorbs every push that was dropped while it waited; nothing is
skipped.

## The failure mode: a run that holds the group without running

`cancel-in-progress: false` protects a run that is doing nothing just as firmly
as one mid-migration. A job parked in the `waiting` state on the Production
environment gate holds the group for up to 30 days — that is GitHub's approval
timeout, and there is no shorter one. `timeout-minutes` does not help: a job's
clock starts when the job starts, and a parked job never starts.

Two things make this worse than a plain failure:

- **Nothing ships.** Every later push queues as `pending`, GitHub keeps only the
  newest, and main stops reaching production.
- **Nobody hears about it.** The parked run never fails, so `notify-failure`
  never fires and the Discord deploy channel stays quiet. Its own notify jobs
  run under `environment: Production` as well, so the gate silences them too.

This happened in August 2026: run #1337 finished `detect-changes` and
`deploy-app-web`, then parked on `check-rollback` at the environment gate — a
required-reviewer rule had been removed mid-run, and removing it does not
release a deployment already pending against it. Main went two days without a
production deploy and no alert fired.

## The watchdog

`production-deploy-watchdog.yml` runs every 15 minutes and cancels a run that
holds the group without executing anything: at least one parked job, no job
`in_progress`, and no movement for 45 minutes. Cancelling costs nothing — the
queued run takes the group immediately and redeploys from the last successful
baseline. If cancelling empties the group, the watchdog dispatches a fresh run
so the wedge ends in a shipped commit; it spends at most one dispatch per head
SHA, so a gate that stays broken produces one retry and an alert rather than a
deploy loop.

A run that is genuinely executing is never cancelled. Past 150 minutes it gets a
Discord ping and a human decides.

One operator-facing wrinkle: the retry budget cannot tell the watchdog's own
dispatch from your `gh workflow run production-deploy.yml` on the same commit,
because production-deploy declares no dispatch inputs to mark. So a manual
dispatch spends that SHA's retry — if the run you started then stalls, the
watchdog cancels and reports it rather than starting another one.

The watchdog deliberately does **not** declare `environment: Production` —
running under the gate it exists to break would park it too. That also means it
only reads repository-level secrets; if `DISCORD_DEPLOY_WEBHOOK` is scoped to
the Production environment, the notify step no-ops and the job summary carries
the report.

Decision rules and their tests: `scripts/production-deploy-watchdog.mjs`,
`scripts/production-deploy-watchdog.test.mjs`.

## Runbook: main has not deployed

1. Open the [Production Deploy runs](https://github.com/boardsesh/boardsesh/actions/workflows/production-deploy.yml).
   A run showing **waiting** is parked at the environment gate; one showing
   **pending** is queued behind it and is fine.
2. If a run is parked, either approve its pending deployment or cancel it. The
   queued run starts on its own once the group frees.
3. Check **Settings → Environments → Production** for a required-reviewer or
   wait-timer rule that should not be there. Removing the rule does not release
   deployments already pending against it — cancel those runs too.
4. If no run holds the group and main still has not shipped, dispatch one:
   `gh workflow run production-deploy.yml`. A dispatched run deploys every
   target rather than diffing against a baseline.
5. `Production Deploy Watchdog` → **Run workflow** with **dry run** ticked
   reports what it would cancel without touching anything.
