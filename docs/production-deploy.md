# Production deploys: the concurrency group, and what to do when main stops shipping

`production-deploy.yml` is the only production deployer (Vercel's native git
auto-deploy is off). Every push to `main` starts a run; the run builds web and
backend in parallel, gates on both builds passing, migrates, then deploys.

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
