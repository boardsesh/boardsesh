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

The service `648faad6…` below is the PG16 cluster, deleted on 2026-09-25. For the
PG18 primary, use the rollback in the next section.

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

This gate covered the PG16 cluster. For the PG18 primary the owner chose on
2026-09-26 to go straight to 4 GB without the seven-day window, accepting slower
online queries (next section). Rollback there is on OOM kills and restarts only.

## PG18 primary: 4 GB cap, September 26

The PG18 primary (`PostGIS - PG18`, service `f122fc1f-b90a-4395-989b-8ee361da8820`)
came up after the cutover with a 24 vCPU / 24 GB ceiling and initdb's memory
defaults. Railway bills memory on usage, and usage includes the kernel page cache,
so the cache grew into whatever the ceiling allowed.

Measured before the change, with pg_stat_statements covering the previous 25 hours:

| Measurement | Value |
| --- | ---: |
| RAM, six-day average / peak | 7.5 GB / 12.8 GB |
| RAM, the ten hours after #5766 | 4.2 GB rising to 9.9 GB |
| CPU, the ten hours after #5766 | 0.17 vCPU average, 1.8 peak |
| Database size | 12 GB |
| `shared_buffers` | 128 MB |
| Shared-buffer hit rate | 54% |
| Temporary files written since initdb | 3.2 TB |
| Client connections | 50, all idle between requests |

PostgreSQL itself held about 1 GB; the rest was page cache. Most of it was fed by
the live Jaccard similar-climbs query: 3,059 calls in 25 hours, 900 ms each, 128,000
sequential scans of `board_climb_holds` and about 2.7 TB of page-cache reads. #5766
moved everyone but admins to `board_climb_neighbors`, and a 100-second sample after
that deploy showed no calls to it. The largest remaining reader is the sitemap climb
query (`packages/web/app/lib/seo/sitemap/climb-query.ts`), about 2.6 GB per call,
run a handful of times a day.

At **2026-09-26 00:08 UTC** the ceiling changed to 8 vCPU / 4,000,000,000 bytes.
Before that, these went into `postgresql.auto.conf` with `ALTER SYSTEM`:

| Setting | Before | After |
| --- | ---: | ---: |
| `shared_buffers` | 128 MB | 1 GB |
| `effective_cache_size` | 4 GB | 2.5 GB |
| `work_mem` | 4 MB | 16 MB |
| `maintenance_work_mem` | 64 MB | 256 MB |
| `random_page_cost` | 4 | 1.1 |
| `jit` | on | off |

`max_connections` stays at 100. It has been 100 since the PG18 cutover, not the
200 PG16 had. Steady state is about 50 client connections: five backend replicas
and web on the runtime role, plus pg-boss and the detector. A deploy briefly runs
the old and new backend fleets side by side while the old one drains. That can
approach the limit, but the logs show no "too many clients" errors since the
cutover. Raising it must start on the homelab standby: a hot standby refuses to
start with a lower value than its primary, so raising the primary first would stop
replication. The limit change restarted the service. Postgres was accepting connections
again 20 seconds later with `shared_buffers = 1GB`, the homelab standby resumed
streaming with no lag, and `/health/db` returned 200. The CPU ceiling is a safety
rail only; CPU is billed on usage.

Slower online queries are an accepted cost. Climbers who want fast search download
the offline climbs database, and the app prefers it. In a five-minute sample 40
minutes after the restart, the mean statement went from 7.7 ms to 17 ms. The
climb-stats history lookup went from 94 ms to about 980 ms, and a few catalogue
count queries went from 0.3 s to 2.6 s. Those are the queries that no longer fit in
cache; the fixes are tracked in #5814.

`work_mem` is per sort or hash step, not per connection, so it is the one setting
that can push memory past the cap. Fifty idle connections cost nothing, but ten
concurrent heavy queries with two sorts each could claim 320 MB on top of the 1 GB
of shared buffers. That still fits in 4 GB. Watch for OOM kills if the number of
concurrent catalogue queries grows.

Roll back on an OOM kill or an unexplained restart, not on latency alone. Go back to
12 GB, not 24. The settings can stay: they fit in 12 GB too.

```sh
railway environment edit --project afceee45-0af1-46b3-abbe-8b9094c23bc6 --environment production --message 'Restore PostGIS PG18 12 GB memory ceiling' <<'JSON'
{"services":{"f122fc1f-b90a-4395-989b-8ee361da8820":{"deploy":{"limitOverride":{"containers":{"cpu":8,"memoryBytes":12000000000}}}}}}
JSON
```

After any restart, probe the database itself. Railway can report `state: live`
while the container is wedged; `redeploy` recovers it.

### Read-only access for investigations

Use the `boardsesh_readonly` role for analysis, never the superuser. It has
`pg_read_all_data` and `pg_monitor` (so it can read `pg_stat_statements`), defaults
to read-only transactions, has a 120-second statement timeout and at most five
connections. Its connection string is the `connection string` field of the
1Password item `RAILWAY Postgres PROD (readonly)` in vault `Boardsesh`. The
`DATABASE_URL` (runtime role) and `DATABASE_DIRECT_URL` (superuser) items point at
the PG18 proxy since September 26; before that they still named the deleted PG16
proxy.

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
