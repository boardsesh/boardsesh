# Railway private traffic and backend capacity

This records production changes and measurements from **2026-09-07 UTC**.
It is a historical snapshot, not a statement of current topology, access or
resource limits. The changes reduced public egress and duplicated backend
memory through runtime configuration, separate from application image releases.
No production configuration changes are made by this documentation PR.

## Applied on 2026-09-07 (UTC)

| Change | Previous | Applied on September 7 | Confirmed healthy |
| --- | --- | --- | --- |
| Web server GraphQL URL | public backend fallback | `ws://boardsesh-backend.railway.internal:8080/graphql` | 07:20:24 |
| Backend replicas, us-west2 | 5 | 3 | 07:24:05 |

The web runtime variable is `BACKEND_INTERNAL_URL`. The existing resolver uses it
only on the server; it converts `ws://` to `http://` for GraphQL HTTP requests.
Browsers still use the public WebSocket URL. Public asset URL generation uses
`getPublicBackendHttpUrl`, so internal hostnames do not enter image URLs.
The backend listens on port 8080 without a host restriction, supporting Railway's
private IPv6 networking. Database and Redis URLs were already private.

The observed web deployment was `f87f7c9b-5ef7-400f-8b90-e7acb7785ad0`; the backend
deployment was `65a0d2d9-e118-4232-9adb-30d15ab637af`. Railway reported one healthy web replica
and three healthy backend replicas with no recent failures. Backend per-replica
limits were 6 vCPU and 8 GB. Web stayed at one replica because its revalidation
cache is not coordinated across instances.

Verification: the production web smoke passed eight configured checks, including
anonymous auth, ws-auth and sitemap SSR. Three fixture-dependent checks were
skipped. The setter sitemap was temporarily degraded on the first two attempts
and recovered on the third. The backend production smoke passed on its first
attempt, including GraphQL schema and both board-render responses. These probes
do not substitute for an authenticated climb/session check or peak-traffic
observation. The existing URL-resolver tests verify public URLs remain public. A separate
anonymous GraphQL WebSocket connection received `connection_ack` after scaling.

At 07:39 UTC, PostGIS reported 9.59 GB total cgroup memory: 5.50 GB inactive file
cache, 0.71 GB anonymous memory, 2.22 GB shared memory and 0.19 GB kernel memory.
All `memory.events` counters, including OOM and limit events, were zero since the
restart. There were 38 client connections (36 idle, two active). This is a point
sample, not the seven-day evidence needed for another reduction.

## Observation gate recorded on September 7

The earliest proposed reduction to two replicas was **2026-09-08 07:24 UTC**.
That date passing does not establish that the gate passed; no later observation
result is recorded here. The gate required comparing a full day
against the five-replica baseline: memory and CPU per replica, HTTP error rate,
GraphQL latency, WebSocket reconnects, pool saturation and scheduled-job periods.
Three healthy replicas shortly after scaling are not sufficient evidence.

The proposed reduction required no new crashes/OOMs, sustained memory
below 70% of each replica's limit, unsaturated CPU, and no regression in
latency/errors or reconnects. Otherwise the plan was to retain three or restore
five, keeping Redis pub/sub and the existing connection-pool settings.

PostGIS was independently reduced from 24 to 12 GB at 07:01 UTC. Its initial
restart interrupted database probes for roughly two minutes; recovery was
confirmed at 07:03. At 07:28, memory was about 9.9 GB as caches warmed. Do not
infer steady-state savings from the cold-cache sample. The separate cost-baseline
PR documents the seven-day gate for considering 8 GB and the 24 GB rollback.

At the time of these measurements, the hourly resource-snapshot workflow in
PR #5267 had not merged; its existence was not evidence of active collection.
The plan required reviewing captured metrics and health results before either
later reduction. The hard billing cap recorded then was $250.

The reduction to two replicas was applied on 2026-09-26 at 03:28 UTC and is
recorded in [railway-cost-reduction.md](./railway-cost-reduction.md).

## Reapply and rollback commands recorded on September 7

Check current service identities, configuration and capacity requirements before
using these historical commands. They are reference material, not authorization
for a new production change.

Project: `afceee45-0af1-46b3-abbe-8b9094c23bc6`; environment: `production`.

```sh
railway variables set -p afceee45-0af1-46b3-abbe-8b9094c23bc6 -e production \
  -s c60e7c36-9080-4968-8370-381ec8804b9c \
  'BACKEND_INTERNAL_URL=ws://boardsesh-backend.railway.internal:8080/graphql'
railway scale -p afceee45-0af1-46b3-abbe-8b9094c23bc6 -e production \
  -s 5912f97f-aa1e-4274-8fbf-eed5da0dceb9 us-west2=3
```

To restore public server traffic, set `BACKEND_INTERNAL_URL` to
`wss://ws.boardsesh.com/graphql` on the same web service. To restore backend
capacity, repeat the scale command with `us-west2=5`. Both trigger deployment
changes; check health and the production smoke afterward.

## ClickHouse diagnostic boundary

At 07:28 UTC, the last 24 hours averaged 2.83 GB RAM and 0.136 vCPU; current disk
usage was 2.14 GB. The last startup logs direct detailed ClickHouse logs to files
inside the container, so Railway's deploy logs cannot establish table retention,
cache sizes or query-log growth. No cache or retention change was applied during that audit.

The audit could not use `railway ssh` because an account key was not registered. Automatic approval
review rejected registering that key because it changes persistent account
access. It also rejected an open-ended Railway agent diagnostic because the tool
can mutate production. Direct metrics/log reads were used instead. Internal
ClickHouse measurements remained pending access; no workaround or temporary public
proxy was created. Current access has not been rechecked for this record.

Run `docs/railway-clickhouse-audit.sql` through an already authorized internal
ClickHouse client with `--readonly 1 --max_threads 1 --max_execution_time 10
--max_memory_usage 67108864`. The SELECT-only queries report aggregate metadata,
not event contents or query text. Execute them individually if optional system
logs are disabled. Also collect cgroup `memory.current`, `memory.stat` and
`memory.events` from an authorized container shell to distinguish anonymous
memory from reclaimable file cache.

Propose cache ceilings only after separating cache from active query memory.
Propose log/event TTLs only after checking current TTLs and the monitoring window
needed for OTA diagnosis. Applying retention can delete history and requires
explicit approval. Do not turn off monitoring during the first resource changes.
