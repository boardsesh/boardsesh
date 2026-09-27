# Background workers

The queue foundation shipped through #5587 (superseding the unmerged #5547).
J01 (#5614, epic #5613) adds an independent backend worker entry point and
durable attempt/settlement infrastructure. PR-1 of #5800 adds the family
registry: every job names a family, and the worker dispatches on it.
`worker-probe` is served by every role. PR-B1 of #5800 adds the first three
batch families (below); each stays off until `BATCH_FAMILIES_ENABLED` names
it, and its GitHub Actions workflow keeps running until the cutover. **Personal
imports, delivery and the other cron migrations are still separate issues.**
Starting this image does not replace a sync daemon.

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
migrator with `MIGRATION_WORKER_ROLES`, a comma list of `<worker-role>=<login>`
entries:

```sh
MIGRATION_WORKER_ROLES=interactive-import=boardsesh_worker_interactive_import,routine-provider=boardsesh_worker_routine_provider,maintenance-delivery=boardsesh_worker_maintenance_delivery,batch=boardsesh_worker_batch
```

The owner pre-creates queues (below) and grants every listed login pg-boss DML
plus SELECT/INSERT/UPDATE on `background_job_runs`. A `<worker-role>=` prefix
adds that role's data grants from `WORKER_ROLE_DATA_GRANTS` in
`packages/db/src/job-queue-schema.ts`, plus USAGE on the sequences behind
those tables; a bare login gets the queue and ledger only. The lists are
authoritative: the migrator revokes a login's `public` table and sequence
grants before granting, so a table removed from a list (or a login moved to a
bare entry) loses its grant on the next migration. Today only `batch` has data
grants (see "Batch families"). Runtime users must never be migration owners.
The existing runtime and detector grant contracts remain supported.

## Queues

| Queue | Policy | Consumer |
| --- | --- | --- |
| `background-interactive-import` | `stately` | `interactive-import` worker |
| `background-routine-provider` | `stately` | `routine-provider` worker |
| `background-maintenance-delivery` | `stately` | `maintenance-delivery` worker |
| `background-batch` | `stately` | `batch` worker |
| `background-schedule` | `standard` | backend (schedule fan-out) |
| `background-job-reconcile` | `singleton` | backend (reconciliation) |

The per-role queues replace the `background-probe-<role>` queues, which were
`standard` and are no longer created or consumed. A probe still queued in one
at deploy time is never run; probes are disposable, so re-send it with
`operator.ts probe`. The old queues stay in the `pgboss` schema, unused. Probes
now ride the family queue like any other family. pg-boss cannot change a queue's policy after
`createQueue`, so a policy change always means a new queue name.

**Always pass a singleton key.** `stately` admits one queued plus one active job
per `singletonKey`, and a job without one shares the empty key with every other
keyless job on that queue: the second enqueue is silently dropped.
`enqueueBackgroundJobOn` therefore always sends one: the caller's
`singletonKey` override if given, else the family's `singletonKey(payload)`,
else the run ID (no dedup). pg-boss sees it as `<family>:<key>`, so two families
on one queue never dedupe against each other; the ledger stores the unprefixed
key in `background_job_runs.singleton_key`. A stately queue also has one `retry`
slot per key: when two runs share a key and both fail, the second one's retry
insert collides and it lands in `failed` with `retry_count < retry_limit`, so a
keyed family must coalesce its work before enqueue rather than rely on retries.

## Job families

A family module lives in `packages/backend/src/workers/families/<name>.ts`,
is listed in `BACKGROUND_JOB_FAMILIES` (`packages/db/src/background-jobs.ts`)
and registered in `families/index.ts`. The build fails if a listed name has no
module. The module declares:

- `name` and `roles`: the worker roles allowed to run it (most have one).
- `options`: `expireInSeconds` (one attempt's lease, at most 24 h),
  `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax`,
  `heartbeatSeconds` (at least 10), and `deadlineSeconds`, the absolute
  deadline for the whole run across retries (`deadline_at`). All of them go on
  each job at `send()`; the queue defaults apply to nothing we send.
- `payload`: a zod schema. It runs at enqueue and again before `execute`. The
  payload must be a JSON object and must name what to work on, never how to
  authenticate: no credentials, tokens or provider URLs.
- `singletonKey(payload)` (optional): the natural dedup key, such as a
  credential ID.
- `schedules` (optional): `{ key, cron, tz?, role?, fanOut(db) }` entries (see
  below). `role` is required when the family serves more than one role; each
  `fanOut` result may also carry its own `role`.
- `execute(context, payload)`. `context` carries `runId`, `family`, `signal`,
  `transaction(callback)` for every write (the attempt fence) and `database`
  for unfenced reads only. Provider HTTP goes through neither.

| Family | Roles | Lease | Retries | Deadline | Key |
| --- | --- | --- | --- | --- | --- |
| `worker-probe` | all four | 120 s | 3, 15 s backoff to 120 s | 24 h | run ID |
| `refresh-recommendations` | `batch` | 1,200 s | 2, 300 s backoff to 900 s | 20 h | `nightly` |
| `refresh-hold-features` | `batch` | 1,200 s | 2, 300 s backoff to 900 s | 20 h | board |
| `refresh-climb-grades` | `batch` | 1,800 s | 1, after 900 s | 20 h | `nightly` |

Throw `BackgroundJobError(code)` from `execute` to record a bounded,
credential-free `error_code` (`/^[A-Z][A-Z0-9_]{0,63}$/`); pass
`{ retryable: false }` to end the run now instead of spending retries. Any other
error records `ATTEMPT_FAILED` and retries. A run whose family the worker's role
does not serve fails with `UNKNOWN_FAMILY`, and a stored payload the schema now
rejects fails with `INVALID_PAYLOAD`; both cancel the pg-boss job (no retry),
and the worker keeps polling. Deploy consumers before producers so a new family
never reaches a worker that cannot run it.

### Enqueueing and dedup

`enqueueBackgroundJobOn(transaction, boss, { family, payload, role?, runId?,
singletonKey? })` validates the payload, inserts the run row and sends
`{ runId }` inside the caller's transaction (`enqueueBackgroundJob` opens one).
`role` is required only for a family with more than one role. When pg-boss
drops the send because a queued job already holds the key, the ledger insert is
rolled back to a savepoint, the existing queued run is found through its key,
`ALREADY_QUEUED` is logged and that run's ID is returned with
`alreadyQueued: true`. The rollback is a savepoint, not a DELETE, because worker
logins deliberately cannot delete ledger rows. If the queued twin was fetched
(or cancelled) between the dropped send and the lookup, the enqueue tries once
more, which normally succeeds because the queued slot is now free; if it is
dropped again with no queued holder, the running holder's run is returned. It
never throws out of the caller's transaction for a dedup.

### Schedules and `BATCH_FAMILIES_ENABLED`

Only the backend registers schedules; the worker's queue client is built with
`schedule: false`. On boot the backend reads `BATCH_FAMILIES_ENABLED`, a comma
list of family names (unset or empty: none). An unknown name, or an enabled
multi-role family whose schedule names no role, removes every family schedule,
registers nothing and logs an error; the backend still boots. For every schedule
of an enabled family it calls
`boss.schedule('background-schedule', cron, { family, key }, { key:
'<family>:<key>', tz: tz ?? 'UTC', missed: 'once' })`, and it unschedules every
other key on that queue, so disabling a family removes its schedules on the next
boot. With at least one family enabled it also starts one
`background-schedule` consumer (`localConcurrency: 1`) that runs the schedule's
`fanOut(db)` and enqueues one job per result. `ALREADY_QUEUED` counts as
success. A failed fan-out throws so pg-boss retries the tick. A failed single
enqueue is logged with a bounded code (never payload contents), counted and
skipped, since retrying the tick would duplicate every job that did enqueue
under a run-ID key. When every request in a tick fails, nothing was enqueued, so
the tick throws and pg-boss retries it.

## Batch families

Three nightly data jobs that ran only on GitHub Actions now also run on the
batch worker. The job bodies live in `packages/db/src/jobs/` (package export
`@boardsesh/db/jobs`) and take `{ db, signal, transact, log, ...params }`: `db`
for reads, `transact` for every write batch, and they throw instead of exiting.
The CLIs in `packages/db/scripts/` pass `db.transaction`; the families pass the
attempt fence (`context.transaction`). The worker never imports
`scripts/db-connection.ts`, which loads dotenv files and exits on a missing URL.

| Family | Cron (UTC) | Payload | Heartbeat | Writes | Workflow it replaces |
| --- | --- | --- | --- | --- | --- |
| `refresh-recommendations` | `0 6 * * *` | `{}` | 30 s | `board_setter_stats`, `board_climb_send_stats`, the public cohort playlists, the weekly `board_climb_stats_history` catch-up | `refresh-recommendations.yml` |
| `refresh-hold-features` | `15 6 * * *` | `{ board = 'kilter', dryRun?, shadow? }` | 30 s | `board_hold_features`, the shadow `user_hold_classifications` | `refresh-hold-features.yml` |
| `refresh-climb-grades` | `30 6 * * *` | `{ refit?, dryRun?, validateOnly? }` | 900 s | `board_grade_coefficients`, `board_climb_grades` | `refresh-climb-grades.yml` |

Measured on GitHub Actions against production in Sep 2026: recommendations
about 25 s, hold features about 60 s, grades about 4 minutes, of which the
publish transaction was 69 s with 99.7% of rows held by hysteresis.

**A fenced write batch must finish inside the heartbeat window.** The fence
holds the run row's lock until it commits, and the worker's heartbeat needs
that lock, so no touch lands while a batch runs; the fence then rechecks the
heartbeat before commit. A batch longer than `heartbeatSeconds` therefore
always loses its attempt. Recommendations and hold features write in short
batches (the longest are the setter-stats upsert, about 8 s, and the weekly
MoonBoard history snapshot, about 5 s). The grade publish is one transaction
on purpose (coefficients, gates and every board's grades commit together), so
that family's heartbeat is 900 s. Size any new family's heartbeat to its
longest batch, not to its whole run.

`refresh-climb-grades` fails a blocking validation gate with
`BackgroundJobError('GATES_FAILED', { retryable: false })`: nothing was
written, and the same data fails the same gate. The payload cannot set
`allowEmptyBacktest`, `publishCrossAngleEstimates` or `contentPriorFile`; those
stay CLI-only, as in the workflow. Every heavy grade read runs with
`max_parallel_workers_per_gather = 0` in its own short transaction (a session
`SET` would reach only one of the worker's two pooled connections).
`refresh-hold-features` runs its reads one at a time for the same pool budget.

**Batch container environment**, beyond the common worker variables:

| Variable | Value |
| --- | --- |
| `WORKER_ROLE` | `batch` |
| `NODE_OPTIONS` | `--max-old-space-size=4096` (the grade job holds every board's stats in memory) |
| `POSTHOG_PERSONAL_API_KEY` | PostHog personal key with query access. Unset: the send stats are skipped and the run logs a warning. |
| `POSTHOG_PROJECT_ID` | Optional, default `412845` |
| `POSTHOG_HOST` | Optional, default `https://us.posthog.com` |

The PostHog request runs outside every fence with a 60 s timeout joined to the
job's signal.

**Grants.** `batch=<login>` gets SELECT on the catalog and history the jobs scan
(`board_climbs`, `board_climb_stats`, `board_climb_holds`, `board_placements`,
`board_holes`, `board_sets`, `board_product_sizes_layouts_sets`,
`board_climb_embeddings`, `board_climb_aliases`), SELECT on `boardsesh_ticks`
and on `user_boards (id, gym_id)` for the grade model's evidence, and the writes
above: `board_setter_stats`, `board_climb_send_stats`, `playlists`,
`playlist_ownership`, `playlist_climbs`, `sync_deletions` (INSERT, from the
`playlist_climbs` delete trigger), `board_climb_stats_history`,
`board_shared_syncs` (the weekly snapshot watermark), `board_hold_features`,
`user_hold_classifications`, `board_climb_grades`, `board_grade_coefficients`.
On `users` it may read `id` and insert `(id, name, email)` only, for the two
reserved system users. The grade publish creates a temporary table, so the
database must keep PostgreSQL's default TEMPORARY privilege for PUBLIC.
`packages/backend/src/services/__tests__/job-queue-roles.test.ts` runs every
family under exactly these grants; a job that starts reading or writing a new
table fails there until the list grows.

**Operator runs** (on the batch host, with the worker environment and
`WORKER_OPERATOR_ENABLED=true`):

```sh
node --import tsx packages/backend/src/workers/operator.ts enqueue refresh-recommendations
node --import tsx packages/backend/src/workers/operator.ts enqueue refresh-hold-features '{"board":"tension","dryRun":true}'
node --import tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-grades '{"refit":true}'
node --import tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-grades '{"validateOnly":true}'
```

Each family has one dedup key (per board for hold features), so a manual run
enqueued while the nightly run is queued returns that queued run with
`ALREADY_QUEUED`; enqueue again once it has started.

**Cutover, one family at a time** (recommendations, then hold features, then
grades):

1. Deploy the migrator with `batch=boardsesh_worker_batch` in
   `MIGRATION_WORKER_ROLES`, and the batch worker with the environment above
   and `WORKER_PAUSED=false`.
2. Add the family to the backend's `BATCH_FAMILIES_ENABLED` and redeploy. The
   Actions workflow keeps running too, on the same cron but hours late (GitHub
   started these 06:00 UTC crons at 10:40 to 11:50 in Sep 2026). Every job is
   idempotent, so the overlap costs one duplicate run a night.
3. Wait for three `succeeded` ledger rows for the family, and compare their
   log output (row counts per phase) with the same nights' workflow logs.
4. In a follow-up PR, delete that workflow's `schedule:` block and keep
   `workflow_dispatch` for manual runs. Update the pin in
   `scripts/__tests__/batch-families-cron.test.ts` in the same PR.

Rollback: remove the family from `BATCH_FAMILIES_ENABLED` (the backend
unschedules it on boot) and restore the workflow's `schedule:` if step 4
already landed.

## Attempts, retries and reconciliation

Queue payloads contain only `{ runId }`; the run row carries `family`,
`payload` and `singleton_key`. The run UUID is also the pg-boss job ID and
enqueue idempotency key. A run plus its queue insertion commit in the same
transaction. Leases, retries and the run deadline come from the family (the
probe: 24-hour deadline, 120-second attempt lease, 30-second heartbeat, three
retries with 15-second exponential backoff capped at 120 seconds); queues keep
seven-day retention. Workers touch the job at least three times per heartbeat
window.

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

## Operator commands and health

Operator commands run on a trusted host, authenticated by OS access and a
restricted database login; there is no public enqueue API. Set
`WORKER_OPERATOR_ENABLED=true` explicitly. With the same worker environment:

```sh
node --import tsx packages/backend/src/workers/operator.ts enqueue <family> ['<json-payload>'] [--id <request-uuid>]
node --import tsx packages/backend/src/workers/operator.ts status <run-uuid>
node --import tsx packages/backend/src/workers/operator.ts replay <failed-run-uuid> [--id <request-uuid>]
node --import tsx packages/backend/src/workers/operator.ts probe [<request-uuid>]
```

`enqueue` accepts only a family that `WORKER_ROLE` serves, and only a payload
that family's schema accepts (default `{}`). Reuse the request UUID after a lost
acknowledgement. Replay accepts only a failed/cancelled run in the configured
role and enqueues a new run with the same family and payload, revalidated
against today's schema; it keeps an explicit singleton key and lets a run-ID key
default again. It never blindly replays external provider side effects beyond
what the family itself does. Omitting `--id` generates a UUID and prints it.
`probe` is the old `enqueue`. No command accepts a queue name or SQL.

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
