# Production deploys: the concurrency group, and what to do when main stops shipping

`production-deploy.yml` is the only production deployer (Vercel's native git
auto-deploy is off). Every push to `main` starts a run; the run builds web and
backend in parallel, gates on both builds passing, migrates, then deploys.

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
| `railway`            | no     | yes     | Needs `RAILWAY_WEB_SERVICE_ID`.                |
| `vercel,railway`     | yes    | yes     | Either order; whitespace and casing ignored.   |
| `none`               | no     | no      | The web hold. Discord gets `notify-web-held`.  |

Anything else — an unknown name, `none` mixed with a real target, or `railway`
while `RAILWAY_WEB_SERVICE_ID` is empty — fails `resolve-web-targets`, which
skips every web deploy and fires `notify-failure`. It never guesses.

The GHCR image is built and pushed on **every** run regardless of the setting,
including under `none` and under an active Instant Rollback. The image is the
artifact; publishing it costs nothing and is what lets a later `railway
redeploy` promote without a rebuild.

`WEB_DEPLOY_TARGETS` is read by a job (`resolve-web-targets`) rather than by a
job-level `if:`, and that is load-bearing: a job-level `if:` is evaluated before
the environment is attached, so `vars.` there only ever sees **repository**
variables. An environment-scoped setting read that way would silently resolve to
empty.

Production-environment config this needs:

| Name                     | Kind | Purpose                                                       |
| ------------------------ | ---- | ------------------------------------------------------------- |
| `WEB_DEPLOY_TARGETS`     | var  | The switch above. Absent is fine — it means `vercel`.          |
| `RAILWAY_WEB_SERVICE_ID` | var  | The Railway `web` service. Required before targeting railway.  |
| `RAILWAY_WEB_ORIGIN`     | var  | Origin for the post-deploy smoke. Unset skips the smoke, with a notice. |

### Single replica (web)

The Railway web service runs **exactly one replica**. Off Vercel, Next's
`unstable_cache` and `revalidateTag` are per-instance: a second replica would
serve its own divergent cache, and a `revalidateTag` on one would leave the
other stale with nothing to reconcile them. Keep it at one replica until a Redis
`cacheHandler` exists (#4658). Scale the backend horizontally instead — it is
stateless and coordinates through Redis.

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
