# Railway status alerts

`.github/workflows/railway-status-watch.yml` reads Railway's status page every 10 minutes and
posts to the deploy channel in Discord when an incident touches something Boardsesh runs.

## Why it exists

On 2026-10-03 a Railway US West storage incident made `/graphql` time out for 6.7 hours.
Postgres sat at 0.05 of 8 vCPU while single-file fsyncs took up to 18 seconds. We heard about it
from a climber, then ruled out our own code before anyone opened `status.railway.com`.

## What it is not

It is not an outage detector. Railway's first update for that incident was stamped 00:34 UTC and
our timeouts began at 23:30 UTC. Sentry uptime on `/health/db` is still the first alarm
(`docs/db-connectivity.md`). This workflow answers "is it Railway?" once something already looks
wrong, and tells you when they say it is over.

## What posts

The feed is `GET https://status.railway.com/api/status` (JSON, no auth). Each incident lists
components as `{ name, groupName, impact }`. A component counts only when its `impact` is not
`OPERATIONAL`; Railway lists every component an incident might touch and marks the unaffected
ones operational.

| Tier | Components | Post starts with |
| --- | --- | --- |
| users | US West: Compute, Storage, Networking — Public, Networking — Private | 🚨 Railway incident likely affecting Boardsesh |
| deploys | US West: Deployments. Any region: API — backboard.railway.com, Image Registry — GitHub (GHCR) | 🟡 Railway incident may stall deploys |
| ignored | Other regions. Builds, Storage Buckets, Sandboxes, Dashboard, Logs, Metrics, Billing, Domains, Authentication | nothing |

An incident matching both tiers posts as `users`. An update with status `RESOLVED` starts with
✅ instead. Against the 28 incidents in the feed on 2026-10-04, these rules post for about half.

Every update of a matching incident is one message: Investigating, Identified, Monitoring,
Resolved. A `users` post also carries one live probe of `https://ws.boardsesh.com/health/db`, so
the message says whether we are actually failing, not just whether we might be.

The rule sets are the exported constants at the top of `scripts/railway-status-notify.ts`. Moving
a service to another region, or starting to use Railway buckets, is a one-line change there.

## How it avoids posting twice

The script keeps a list of update IDs it has posted in `.boardsesh/railway-status-seen.json`. The
workflow carries that file between runs with `actions/cache`: restore by the `railway-status-seen-`
prefix, save under a new key only when the list changed.

- An ID joins the list only after Discord accepts the post. A failed post is retried next run, and
  that run goes red.
- No file (first run, or the cache entry evicted after 7 days without a restore): the script
  records everything in the feed as seen and posts only the latest update of incidents still
  open. It never replays three months of history.
- An unseen update more than 24 hours old is recorded and not posted, so a list that comes back
  empty or stale costs a day of updates at most.
- The list keeps the newest 500 IDs. At most 5 messages go out per run; the rest wait 10 minutes.

## Why GitHub Actions

The scheduler and the pg-boss workers run on Railway or need its Postgres. During the incident
above pg-boss could not get a database connection. `docs/ci-runners.md` lists small alert-only
crons as the kind of job that stays on Actions.

The cron needs no `vp install`: the script is TypeScript run by plain `node` and imports only
`node:` builtins. A test pins that.

## When it goes red

- The feed's shape changed. Railway's status page is their own build with no published schema, so
  the script checks every field it reads and fails loudly instead of reporting "no incidents".
- `status.railway.com` did not answer.
- Discord rejected a post.
- There was something to post and `DISCORD_DEPLOY_WEBHOOK` was not readable. Left green, the update
  would pass the 24-hour mark and be recorded without anyone having seen it.

## Trying it

```
vp run railway:status-notify -- --dry-run
vp run railway:status-notify -- --dry-run --state-file /path/to/empty-list.json
```

A dry run prints what it would post, posts nothing and writes nothing. With no state file it shows
the cache-miss behaviour; with a file containing `{"seenUpdateIds": []}` it shows every matching
update from the last 24 hours, capped at 5.

In GitHub, dispatch the workflow from `main` with `dry_run` ticked. A dispatch from a feature branch
fails on the Production environment gate before any step runs. `release/next` passes the gate, but
a run there is always a dry run: a cache entry saved from another branch is invisible to the
scheduled runs, so a real post from it would go out a second time.

The cache key ends in the run attempt. Re-running a red run therefore restores the newest list, not
the one that run saved the first time, and does not repost.

## Not covered

- Railway's scheduled maintenances (`maintenances[]` in the feed).
- A climber-facing status channel. Posts go to the deploy channel only.
