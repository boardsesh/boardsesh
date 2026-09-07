# Railway private traffic and backend capacity

These production changes reduce public egress and duplicated backend memory.
They are runtime configuration, separate from application image releases.

## Applied on 2026-09-07 (UTC)

| Change | Previous | Current | Confirmed healthy |
| --- | --- | --- | --- |
| Web server GraphQL URL | public backend fallback | `ws://boardsesh-backend.railway.internal:8080/graphql` | 07:20:24 |
| Backend replicas, us-west2 | 5 | 3 | 07:24:05 |

The web runtime variable is `BACKEND_INTERNAL_URL`. The existing resolver uses it
only on the server; it converts `ws://` to `http://` for GraphQL HTTP requests.
Browsers still use the public WebSocket URL. Public asset URL generation uses
`getPublicBackendHttpUrl`, so internal hostnames do not enter image URLs.
The backend listens on port 8080 without a host restriction, supporting Railway's
private IPv6 networking. Database and Redis URLs were already private.

The web deployment is `f87f7c9b-5ef7-400f-8b90-e7acb7785ad0`; the backend deployment
is `65a0d2d9-e118-4232-9adb-30d15ab637af`. Railway reported one healthy web replica
and three healthy backend replicas with no recent failures. Backend per-replica
limits remain 6 vCPU and 8 GB. Web remains one replica because its revalidation
cache is not coordinated across instances.

Verification: the production web smoke passed eight configured checks, including
anonymous auth, ws-auth and sitemap SSR. Three fixture-dependent checks were
skipped. The setter sitemap was temporarily degraded on the first two attempts
and recovered on the third. The backend production smoke passed on its first
attempt, including GraphQL schema and both board-render responses. These probes
do not substitute for an authenticated climb/session check or peak-traffic
observation. The existing URL-resolver tests verify public URLs remain public.

## Observation gate

Do not reduce to two replicas before **2026-09-08 07:24 UTC**. Compare a full day
against the five-replica baseline: memory and CPU per replica, HTTP error rate,
GraphQL latency, WebSocket reconnects, pool saturation and scheduled-job periods.
Three healthy replicas shortly after scaling are not sufficient evidence.

Only proceed to two if there are no new crashes/OOMs, sustained memory stays
below 70% of each replica's limit, CPU is not saturated, and latency/errors and
reconnects have not regressed. Otherwise retain three or restore five. Retain
Redis pub/sub and existing connection-pool settings.

PostGIS was independently reduced from 24 to 12 GB at 07:01 UTC. Its initial
restart interrupted database probes for roughly two minutes; recovery was
confirmed at 07:03. At 07:28, memory was about 9.9 GB as caches warmed. Do not
infer steady-state savings from the cold-cache sample. The separate cost-baseline
PR documents the seven-day gate for considering 8 GB and the 24 GB rollback.

The hourly resource-snapshot workflow in PR #5267 starts after that PR merges;
it is not active merely because the PR exists. Review the captured metrics and
health results before either later reduction. The $250 hard billing cap remains.

## Reapply and rollback

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
cache sizes or query-log growth. No cache or retention change has been applied.

`railway ssh` needs an account key that is not registered. Automatic approval
review rejected registering that key because it changes persistent account
access. It also rejected an open-ended Railway agent diagnostic because the tool
can mutate production. Direct metrics/log reads were used instead. Internal
ClickHouse measurements remain pending access; no workaround or temporary public
proxy has been created.

Run `scripts/railway-clickhouse-audit.sql` through an already authorized internal
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
