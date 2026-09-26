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
that can push memory past the cap. Hash steps get twice as much
(`hash_mem_multiplier` is 2). Fifty idle connections cost nothing, but ten
concurrent heavy queries, each with a hash join and two sorts, could claim 640 MB on
top of the 1 GB of shared buffers. That still fits in 4 GB. Watch for OOM kills if the number of
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

### Runaway guards

Under a 4 GB cap, one query that nobody is waiting for still holds its sort and
hash memory until it finishes. Before these guards the primary had no statement
timeout at all: orphaned queries ran for over 30 minutes after their client had
gone, and in the 21 hours after the 2026-09-25 statistics reset, 33 statement
shapes on the runtime role had at least one run over 45 s (most of it the old
popular-configs statement, which #5833 moved to a daily 18 s cron).

Applied the same way as the memory settings above (applied: _pending_): `ALTER
SYSTEM` as the superuser, into `postgresql.auto.conf`. None of them needs a restart.

| Setting | Before | After | What it does |
| --- | ---: | ---: | --- |
| `client_connection_check_interval` | 0 (off) | 5s | A running query checks every 5 s whether its client socket is still open, and cancels itself if not |
| `tcp_keepalives_idle` | 7200 s | 60 s | Probe an idle TCP connection after 60 s instead of 2 hours |
| `tcp_keepalives_interval` | 75 s | 10 s | Seconds between unanswered probes |
| `tcp_keepalives_count` | 9 | 3 | A dead peer is dropped after 60 + 3 × 10 = 90 s |
| `track_io_timing` | off | on | Read and write times in `pg_stat_statements` and `EXPLAIN (ANALYZE, BUFFERS)`, so a slow query can be told apart from a slow disk |
| `log_lock_waits` | off | on | Logs any lock wait longer than `deadlock_timeout` (1 s) |
| `log_temp_files` | -1 (off) | 10MB | Logs each temp file of 10 MB or more with the statement that wrote it. 3.3 TB of temp files have been written since initdb |

A Unix-socket session reports the keepalive values as 0, so check them from a new
TCP session, through the proxy or the private network.

```sql
-- As the superuser (1Password item `DATABASE_DIRECT_URL`), database `railway`:
ALTER SYSTEM SET client_connection_check_interval = '5s';
ALTER SYSTEM SET tcp_keepalives_idle = 60;
ALTER SYSTEM SET tcp_keepalives_interval = 10;
ALTER SYSTEM SET tcp_keepalives_count = 3;
ALTER SYSTEM SET track_io_timing = on;
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET log_temp_files = '10MB';
SELECT pg_reload_conf();
```

Rollback is per setting, also without a restart:
`ALTER SYSTEM RESET <name>; SELECT pg_reload_conf();`.

Two things are deliberately not set:

- **`temp_file_limit`.** The sitemap climb refresh and a few catalogue counts
  still write large temp files. A limit waits until C9 in
  [postgres-query-costs.md](./postgres-query-costs.md) moves that work to a side
  table.
- **`ALTER ROLE boardsesh_runtime SET statement_timeout`.** kilter-sync connects
  as the same role, and its `board_climb_stats` upserts take 80–135 s. A role
  default would fail them.

#### Statement timeout on backend and web

The timeout goes on the two services that answer people instead:
`DB_STATEMENT_TIMEOUT_MS=45000` on `boardsesh-backend` and `boardsesh-web`.
`packages/db/src/client/postgres.ts` turns it into a `statement_timeout` startup
parameter for every pool made by `createDb`, `createReadDb` and `createPool`. Both
services connect straight to `postgis---pg18.railway.internal:5432`, not through
PgBouncer, so the startup parameter is accepted (see "The `statement_timeout`
hazard" in [db-connectivity.md](./db-connectivity.md)). A transaction that needs
less can still `SET LOCAL` a lower value, as the playlist sitemap does with 15 s.

The longest scheduled statements on those two services fit under 45 s, all
measured since the 2026-09-25 statistics reset:

- The popular-configs cron ran in 17.7 s (16.8–18.2 s with a serial plan on the
  replica). A failed run keeps the previous list in Redis.
- The setters sitemap query, built when a `/sitemaps/setters/N.xml` page misses
  its 6-hour in-process cache, peaked at 33.7 s (13.4 s mean over 34 calls). It
  already runs under `withSerialPlan`, so the serial-plan default below does not
  slow it. It has the least headroom, and a failed build does not keep an old
  list: that page answers 503 and the crawler retries.
- The sitemap climb refresh's largest per-group statement peaked at 8.4 s. A
  failed refresh keeps the stored URL table.
- The weekly profile-percentiles rebuild and the daily gym-activity rebuild did
  not run in that window; their reads take about 1 s and 0.5 s on the replica.

Interactive reads that ran past 45 s will now fail with `57014` instead: the
worst climb-list reads (up to 474 s), a `user_boards ... FOR UPDATE` that waited
168 s on a lock, and one offline-sync pull read of 47 s (0.2 s mean over 476
calls).

The variable is set per service, never as a shared variable: kilter-sync builds
its own pool and ignores it, but aurora-sync and moonboard-sync use `createDb`
and would pick it up.

#### Serial plans

`max_parallel_workers_per_gather` is 2 in production, against the repo contract
of 0 (#5352, #5767). Each parallel worker is another process with its own
`work_mem`, so under the cap it is also a memory setting. It is a database default,
not an `ALTER SYSTEM` setting, and is applied with the script that owns it:

```sh
cd packages/db
DATABASE_URL='<runtime role, 1Password item DATABASE_URL>' \
ADMIN_DATABASE_URL='<superuser, 1Password item DATABASE_DIRECT_URL>' \
  vp run db:verify-serial-plan
```

It checks through the runtime connection, runs
`ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0` through the
admin one only when needed, and checks again. New sessions get the value; pooled
connections keep 2 until they are recycled, so `/health/db` reports
`maxParallelWorkersPerGather: "0"` after the next backend deploy. Rollback:
`ALTER DATABASE "railway" RESET max_parallel_workers_per_gather;` as the superuser.
Once it reads 0, the `verify-serial-plan` deploy job can be re-enabled (#5767).

### Read-only access for investigations

Use the `boardsesh_readonly` role for analysis, never the superuser. It has
`pg_read_all_data` and `pg_monitor` (so it can read `pg_stat_statements`), defaults
to read-only transactions, has a 120-second statement timeout and at most five
connections. Its connection string is the `connection string` field of the
1Password item `RAILWAY Postgres PROD (readonly)` in vault `Boardsesh`. The
`DATABASE_URL` (runtime role) and `DATABASE_DIRECT_URL` (superuser) items point at
the PG18 proxy since September 26; before that they still named the deleted PG16
proxy.

## OTA server Redis cache, September 26

- Applied 2026-09-26 01:08 UTC: `boardsesh-ota-v3` moved from `CACHE_MODE=local`
  to Redis (`boardsesh-ota` key prefix on the shared Railway Redis). Before:
  1.81 GB RSS, 1.74 GB live Go heap, 2.3M objects after 21 days. After, one
  minute past the restart (`/metrics`): 49.8 MB RSS
  (`process_resident_memory_bytes`), 13.4 MB heap in use
  (`go_memstats_heap_inuse_bytes`). `/hc` and `/ready` returned 200 about 50 s
  after the redeploy. Variables set:

  ```sh
  railway variable set --service boardsesh-ota-v3 --environment production \
    'CACHE_MODE=redis' \
    'REDIS_HOST=${{Redis.REDISHOST}}' \
    'REDIS_PORT=${{Redis.REDISPORT}}' \
    'REDIS_PASSWORD=${{Redis.REDISPASSWORD}}' \
    'CACHE_KEY_PREFIX=boardsesh-ota'
  ```

  Rollback: set `CACHE_MODE=local` and remove the four Redis variables
  (`railway variable delete --service boardsesh-ota-v3 --environment production <NAME>`
  for `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `CACHE_KEY_PREFIX`). The
  nightly drift check reports `CACHE_MODE` and the Redis variables while rolled
  back.

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

## October 2026

- **2026-09-26: ClickHouse lean image rollout.** `boardsesh-ota-clickhouse` idled at 2.9 GB ($23.6/month of memory) under a 24 GB ceiling. The new image caps the server at 1.2 GB and each query at 500 MB, shrinks the caches and turns off every system log except `query_log` (7 days); the smoke test measured 271 MB idle against 424 MB for stock 25.3 under the same 2 GB limit. Expected about −$15/month. Image published 2026-09-26 (`ghcr.io/boardsesh/boardsesh-clickhouse@sha256:80d3d4c0dfacbd845476eea56ca239a3d658e868e01389ed264e1a9ecf56f6fd`); pinned on Railway at **2026-09-26 03:08 UTC** with the 2 GB / 2 vCPU ceiling. The deploy log shows `config.d/boardsesh-lean.xml` merged, and live settings confirmed `max_server_memory_usage` 1,200,000,000, `mark_cache_size` 134,217,728, `uncompressed_cache_size` 0, `background_pool_size` 2. Ten leftover system-log tables holding 1.49 GiB (`asynchronous_metric_log`, `error_log`, `latency_log`, `metric_log`, `part_log`, `processors_profile_log`, `query_log_0`, `query_metric_log`, `text_log`, `trace_log`) were dropped through a temporary TCP proxy; only `query_log` remains, with its 7-day TTL. `expo_observe` data was intact afterwards: `update_health_snapshots` 12.27M rows, `device_health_events` 6,060 rows. `MemoryResident` was 754 MiB one minute after boot — not a steady-state reading. After: _measured on <date>_ (settled 24-hour figure). Rollout and rollback: `docs/railway.md`, "Rolling out a new ClickHouse image".
- **Live (2026-09-26, about 03:25 UTC): backend origin compression.** PR #5822 added an in-repo Yoga plugin that prefers brotli quality 5 and falls back to gzip for JSON bodies of 1 KB or more, sending `Vary: Accept-Encoding`. Shipped with production deploy run 36213734764. Verified through Cloudflare: `POST /graphql` returns `content-encoding: br` and `vary: Accept-Encoding`. Before: about 440 GB/month of backend egress ($19.94 in the Aug 26–Sep 26 cycle) with no origin compression. After: _measured on <date>_.
- **Live (2026-09-26, same deploy): crawler allow-list.** PR #5820 added an edge allow-list on www: `Lightpanda/1.0` and `python-requests` now get 403 at the edge, a Chrome user agent still gets 200, and `robots.txt` still lists lightpanda.
- **Applied (2026-09-26 03:28:25 UTC): backend replicas reduced from three to two.** `railway scale -p afceee45-0af1-46b3-abbe-8b9094c23bc6 -e production -s 5912f97f-aa1e-4274-8fbf-eed5da0dceb9 us-west2=2` started a Railway redeploy. Gate evidence over the preceding seven days: total across the three replicas averaged 1.32 GB RAM (max 2.73 GB) and 0.20 vCPU (max 1.91), so under 1 GB and 0.7 vCPU per replica against 8 GB / 6 vCPU limits; 5xx share was 915 of 2,637,114 requests (0.03%). Per-replica limits and `DB_POOL_MAX=10` are unchanged, so the backend now holds 20 Postgres connections instead of 30. Rollback: the same command with `us-west2=3`. 24-hour observation: 5xx share at or below 0.05%, WebSocket reconnects flat, per-replica memory under 70% of the limit.
