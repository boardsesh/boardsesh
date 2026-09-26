# Background workers

The queue foundation shipped through #5587 (superseding the unmerged #5547).
J01 (#5614, epic #5613) adds an independent backend worker entry point and
durable attempt/settlement infrastructure. The first registered family is a
probe for each role. **Personal imports, delivery and existing cron migrations
are still separate issues.** Starting this image does not replace a sync daemon.

## Placement and connection budget

| Role | VM | Active jobs | Application / queue pools |
| --- | --- | --- | --- |
| `interactive-import` | General: 4 vCPU / 8 GiB | 1 | 2 / 1 |
| `routine-provider` | General | 1 | 2 / 1 |
| `maintenance-delivery` | General | 1 | 2 / 1 |
| `batch` | Separate: 4 vCPU / 8 GiB | 1 | 2 / 1 |

This adds at most 12 connections, excluding the existing backend and detector.
Each process consumes only its registered queue, one fetched job at a time.
Role allowlists are enforced in code; pg-boss table DML grants are shared and
are **not SQL-level isolation between queue names**. Adding a family requires
reviewing both its data grants and its role's total concurrency budget.

## Runtime and owner contract

`node --import tsx packages/backend/src/workers/index.ts` starts the worker,
without importing the HTTP/WebSocket server, Redis event bus or mobile code.

Set `WORKER_ROLE`, `DATABASE_URL` and optionally `HEALTH_PORT` (9090). The fixed
budget is `DB_POOL_MAX=2`, `PGBOSS_POOL_SIZE=1`, `WORKER_CONCURRENCY=1`; incompatible
values fail startup. Pools are configured before dynamic handler imports.
`READ_REPLICA_URL` is rejected. `WORKER_PAUSED` defaults to `true`; only the
literal `false` enables consumption. A connected paused worker is healthy and
reports its paused state separately.

Both drivers check the actual writable primary. Remote URLs require
`sslmode=verify-full`, disallow conflicting/overriding connection parameters,
and reject TLS verification bypass. For a private CA, mount the public CA file
read-only and set `NODE_EXTRA_CA_CERTS` before Node starts. Never mount its
private key. Recreate containers after CA changes. Verify both drivers reject
untrusted and wrong-host certificates before production enablement.

The worker refuses superuser/role-management/database-creation privileges and
schema CREATE rights; it also verifies ledger DML and refuses any login that can
DELETE ledger rows, which is how the backend runtime login (CRUD on every
application table, no CREATE) fails closed instead of passing as a worker. Queue startup disables
migration, scheduling, supervision and index DDL. The backend retains pg-boss
supervision and the singleton, once-per-minute reconciliation schedule, so
homelab availability is not required for detecting failed or expired work.

Operators pre-provision dedicated logins, then run the existing deployment
migrator with `MIGRATION_WORKER_ROLES` containing the comma-separated names:
`boardsesh_worker_interactive_import`, `boardsesh_worker_routine_provider`,
`boardsesh_worker_maintenance_delivery`, `boardsesh_worker_batch`.
The owner pre-creates queues and grants pg-boss DML plus SELECT/INSERT/UPDATE
on `background_job_runs`. No provider/user-data grants are added in this slice.
Runtime users must never be migration owners. The existing runtime and detector
grant contracts remain supported.

## Attempts, retries and reconciliation

Queue payloads contain only `{ runId }`. The run UUID is also the pg-boss job ID
and enqueue idempotency key. A run plus its queue insertion commit in the same
transaction. Probe requests expire after 24 hours; queue retries use a
120-second attempt deadline, 30-second heartbeat, three retries with 15-second
exponential backoff capped at 120 seconds, and seven-day queue retention.

Claims lock the run, then its pg-boss row, and check retry count, live lease and
absolute deadline. Each data batch uses `withBackgroundJobAttempt`; it checks
the current attempt token and lease again before commit. Never perform provider
HTTP requests while holding those locks. Future personal imports must also
acquire their logbook/control locks and validate link generation inside each
actual helper transaction as specified in #5615/#5616.

Workers explicitly fetch and settle jobs. They do not use automatic `work()`
acknowledgements: a stale callback must not complete/fail a newer attempt by
job ID. Heartbeats and completion/failure execute under the same run/queue
locks, using the Drizzle transaction adapter. Completion and durable success
are atomic; failure and retry/failed state are atomic. Stale handlers do neither.
Signals abort provider work and prevent subsequent guarded batches. SIGTERM
stops polling, aborts active handlers and drains resources within 120 seconds;
Docker allows 130 seconds before termination. The backend supervisor recovers
leases after an ungraceful exit.

Each backend reconciliation invocation examines at most 100 nonterminal runs,
advancing a cursor past healthy work. It rereads state under both locks before
changing anything. Missing jobs, exhausted retries, cancellation and deadline
expiry become explicit outcomes; stale attempts lose their token. The supervisor
owns actual requeueing. Up to 100 terminal ledger rows older than 30 days are
removed per invocation. Active/retryable records are never purged.

## Operator probes and health

Operator commands run on a trusted host, authenticated by OS access and a
restricted database login; there is no public enqueue API. Set
`WORKER_OPERATOR_ENABLED=true` explicitly. With the same worker environment:

```sh
node --import tsx packages/backend/src/workers/operator.ts enqueue <request-uuid>
node --import tsx packages/backend/src/workers/operator.ts status <run-uuid>
node --import tsx packages/backend/src/workers/operator.ts replay <failed-run-uuid> <new-request-uuid>
```

Reuse the request UUID after a lost acknowledgement. Replay accepts only a
failed/cancelled run in the configured role and creates a new probe; it never
blindly replays external provider side effects. Omitting a new request UUID
generates one and prints it. No command accepts arbitrary payloads or SQL.

Private `/health` reports readiness, role and pause state; stale database contact
returns 503. `/metrics` exports role-labelled readiness, pause, active/pending
counts, oldest pending age, last successful run, process-local completed/failure
counts, RSS/peak RSS and process start time. Counters reset with the process;
backlog and last-success timestamps come from durable records. No credentials,
provider responses or payloads enter logs or metrics. Alert on backlog age and
freshness as well as failures; independent monitors must detect primary outages.

## Deployment and evidence gates

The `Background Worker Image` workflow builds the dependency-scoped
`Dockerfile.worker`, publishes a commit-tagged image and provenance, and leaves
deployment to a separately reviewed, **digest-pinned** Ansible change:
[blackheathdc-ansible #419](https://github.com/marcodejongh/blackheathdc-ansible/pull/419).
Its dedicated inventory and VM allocation checks leave deployment disabled and
workers paused by default. Existing daemon and detector definitions are untouched.

Deploy schema/queues first, compatible consumers second, producers last. Run
probes and fail/retry/drain drills before enabling a real family. Pause and drain
the old owner before enabling its replacement; rollback restores exactly one
owner. Preserve durable pending data and retain schema during image rollback.

Provisioning, trusted production TLS, actual peak memory/primary load and
interactive-plus-routine capacity tests remain deployment gates. The under-30s
eligible import start target cannot be demonstrated until #5615 implements
personal imports. Probe tests are not evidence of provider import throughput.
Do not close #5614's deployment/capacity acceptance items from code tests alone.
