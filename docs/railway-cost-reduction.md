# Railway cost reduction — September 2026

The production project is `afceee45-0af1-46b3-abbe-8b9094c23bc6`, environment
`8cd7204e-8ba4-4790-bb64-6a150971eacd`. All amounts below are US dollars.

## Baseline, September 7

The August 26–September 26 cycle had incurred $89.69, with Railway estimating
$170.08 for the cycle. The previous cycle cost $142.70. Estimates and trailing
resource consumption are different measurements; do not subtract projected
savings from the current-cycle estimate as though they were guaranteed.

| Service | Cost incurred | Seven-day average RAM | Seven-day average vCPU |
| --- | ---: | ---: | ---: |
| PostGIS - PROD | $57.48 | 11.35 GB | 1.35 |
| Backend, all five replicas | $15.38 | 2.84 GB | 0.20 |
| Web | $7.67 | 1.02 GB | 0.16 |
| OTA ClickHouse | $6.37 | 2.47 GB | 0.13 |
| OTA server | $1.69 | 0.35 GB | 0.008 |

Redis, OTA Postgres, the scheduler and the completed temporary backfill together
had incurred $1.10. Keep them and the database backups. Keep the existing $250
hard spending limit: reaching it shuts workloads down.

The database's pre-change cgroup snapshot was 14.00 GB total, including 9.67 GB
of inactive filesystem cache. PostgreSQL had 2 GiB shared buffers, 16 MiB work
memory, a 200-connection ceiling, and 60 current client connections. Cache is
reclaimable, but reclaiming it can increase disk reads and CPU.

## Applied: PostGIS memory ceiling

At **2026-09-07 07:01 UTC**, the memory ceiling changed from 24,000,000,000 to
12,000,000,000 bytes. The 8-vCPU ceiling, image digest, database settings, volume
and backups were preserved. Railway restarted the service to apply the change.
The deployment was `a4e0e295-6781-44e5-8baa-03fc0485cc3a`.

The database probe returned 503 during the restart and recovered by 07:03 UTC;
the recovered probe took 2 ms. At 07:04 UTC, Railway reported approximately
6.9 GB memory consumption. This is a cold-cache observation, not proof of a
sustained saving. The existing collation warning is covered separately by
[the collation repair runbook](./postgres-16-collation-repair.md).

## Observation and rollback

The hourly `Railway Cost Monitor` workflow records resource metrics and the
database health probe as downloadable artifacts. It never changes resources.
Use the same account-authenticated CLI for billing comparisons:

```sh
railway usage --workspace ef65be11-6358-42ad-bbd4-fc3f2073d0b5 --json
railway usage projects --workspace ef65be11-6358-42ad-bbd4-fc3f2073d0b5 --project afceee45-0af1-46b3-abbe-8b9094c23bc6 --json
```

Billing reads require account/workspace access; the workflow's existing project
token is intentionally used only for project resource metrics. Existing Sentry
uptime monitoring remains the immediate database outage alarm.

Restore the previous resource setting on an unexpected OOM/restart, a failed
scheduled job attributable to the reduction, or a latency regression over 20%
for 15 minutes against comparable pre-change traffic. The deliberate initial
Railway restart is recorded above and is not an OOM.

To restore the PostGIS ceiling without changing unrelated settings:

```sh
railway environment edit --project afceee45-0af1-46b3-abbe-8b9094c23bc6 --environment production --message 'Restore PostGIS 24 GB memory ceiling' <<'JSON'
{"services":{"648faad6-ed14-4c51-8297-94179f8a237b":{"deploy":{"limitOverride":{"containers":{"cpu":8,"memoryBytes":24000000000}}}}}}
JSON
```

The next database reduction is gated on **seven full days**, including scheduled
jobs, with non-reclaimable memory below 5 GB and no material regression. Railway's
total memory graph alone cannot establish that gate: collect cgroup
`memory.current` and `memory.stat` to distinguish reclaimable file cache. If this
evidence is missing, retain 12 GB. An 8 GB trial is never automatic.

## Remaining rollout

Ship each item independently so it can be reviewed and rolled back separately:

1. Protect the web origin with a secret header shared by Cloudflare and deployment
   smoke tests. GPTBot bypassed Cloudflare using the public Railway hostname in
   84/501 and 116/501 requests in two short samples.
2. Block automated AI training/search and commercial scraping crawlers while
   retaining traditional search engines and share previews. Validate actual
   origin logs, not just synthetic user-agent probes.
3. Set the web service's existing `BACKEND_INTERNAL_URL` to the backend's private
   Railway address. Browser URLs stay public; Postgres and Redis already use
   private networking.
4. Reduce backend replicas from five to three, observe for at least 24 hours,
   then reduce to two only if health, latency and collaborative sessions remain
   healthy. Retain existing per-replica limits and Redis coordination. Roll back
   to the preceding replica count on a regression.
5. Inspect ClickHouse caches, system logs and retention before proposing tuning.
   Preserve OTA monitoring during the other changes.

Record the actual backend reduction time before beginning its observation
period. Do not count the PostGIS observation period as the backend's period.
Compare seven-day usage after rollout; traffic removal, smaller caches and fewer
replicas overlap, so their estimated savings must not simply be added together.
