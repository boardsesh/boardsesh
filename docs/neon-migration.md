# Neon to Railway PostgreSQL Migration Runbook

Migration from Neon PostgreSQL to Railway PostgreSQL with a homelab read replica.

> [!WARNING]
> This document records the completed Neon-to-Railway move. It is not the
> PostgreSQL 16-to-18 procedure. For the current one-way upgrade, fencing,
> validation, rollback boundary, and PG18 volume contract, use
> [PostgreSQL 18 migration and portability runbook](postgres-18-migration.md).
> In particular, never follow the historical rollback or manual homelab
> reinitialization steps without reconciling them with that runbook and the
> Ansible-managed deployment.

---

## 1. Why We Migrated

- Neon was $50-100/mo, the single biggest recurring expense.
- We used none of Neon's advanced features (no branching, no scale-to-zero reliance).
- Simplification: one driver (`postgres-js`) instead of three (`@neondatabase/serverless` HTTP driver, Neon WebSocket pooler, `postgres-js` for tests).

## 2. Architecture

### Before

```
Vercel Functions → Neon HTTP Driver → Neon PostgreSQL
Backend → Neon WebSocket Pool → Neon PostgreSQL
Local Dev → neon-proxy Docker → Local PostgreSQL
```

### After

```
Vercel Functions → TCP → Railway PostgreSQL (primary)
Backend → TCP → Railway PostgreSQL
Local Dev → TCP → Local PostgreSQL (direct, no proxy)
                                      │
                           async streaming replication
                                      │
                         Homelab PostgreSQL (read replica, AU)
```

## 3. Railway PostgreSQL Setup

1. Create a PostgreSQL instance on Railway. Pick the region closest to where Vercel runs the project's serverless functions — Vercel defaults to `iad1` (US East), and every extra ~30 ms of RTT shows up on every query.
   - **TODO before cutover:** confirm Railway region matches Vercel's `iad1` (or the project's selected region).
2. Enable required extensions:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```
   If `postgis` is unavailable on the plain Railway image, switch to a Railway PostGIS-capable template/image before continuing. The app schema has `geography(Point, 4326)` columns.
3. Use the Railway **direct** Postgres connection string for schema restore, subscription creation, migrations (`packages/db/scripts/migrate.ts`), and one-shot CLI scripts (`packages/db/scripts/db-connection.ts`). Direct URL = no pooler in front, prepared statements work normally.
4. For application traffic (Vercel functions + the backend service), use a **pooled** URL backed by PgBouncer in transaction-pooling mode. The application's `postgres-js` clients are configured with `prepare: false` (see `packages/db/src/client/postgres.ts`) — this is required for transaction-pool mode. Without it you get intermittent `prepared statement "X" already exists` errors when PgBouncer reuses backend connections across transactions. The flag is a safe no-op against direct PostgreSQL.
   - **TODO before cutover:** confirm whether the Railway plan exposes a managed pooled URL out of the box, or whether you need to deploy the `bitnami/pgbouncer` template alongside the database. Either way, verify the pooler is in **transaction-pooling** mode (this is what the application is configured for).
5. Lock down access:
   - **TODO before cutover:** add IP allowlist entries for Vercel egress IPs (or move to a Railway private network).
   - Confirm `sslmode=require` is enforced on the connection string the app receives.

## 4. Data Migration: Railway as Temporary Read Replica of Neon

Instead of a one-shot `pg_dump`/`pg_restore` (which creates a gap where writes are lost), we run Railway as a **logical replica of Neon** during the transition. Every write to Neon streams to Railway in near-real-time. When we're confident Railway is caught up, we promote it and cut over with zero data loss.

### 4.1 Set Up Logical Replication (Neon -> Railway)

Neon supports logical replication as a publisher. Railway PostgreSQL acts as the subscriber.

Use Postgres' initial table synchronization (`copy_data = true`) instead of a full data dump followed by `copy_data = false`. A full data dump taken before the replication slot exists can miss writes that commit between the dump snapshot and subscription creation.

**On Neon (publisher):**

Enable logical replication in the Neon console if it is not already enabled, then verify:

```sql
SHOW wal_level;
```

Create or use a dedicated Neon role that has `REPLICATION`. Neon roles created through the Neon Console, CLI, or API are members of `neon_superuser`; roles created via SQL cannot be granted this privilege manually.

The Railway connection used for `setup` must be a **superuser** (`CREATE SUBSCRIPTION` requires it). Verify before running:

```bash
set +x
PGPASSFILE="$TARGET_PGPASS_FILE" psql -X \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_ADMIN_USER" -d railway \
  -c "SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;"
```

`TARGET_PGPASS_FILE` must be mode `0600`, populated directly by the secret
manager, and contain the exact host, port, database, and user fields (no `*`
wildcards). Do not put a password-bearing URL after `psql`, `pg_dump`, or
`pg_restore`; command arguments are visible to other local processes.

If `usesuper` is `f`, use the Railway `postgres` superuser connection string for the setup script and switch back to the app role after teardown.

Create a publication for application tables. Do not use `FOR ALL TABLES` here: PostGIS installs extension-owned tables such as `spatial_ref_sys`, and copying those into a Railway database that already has PostGIS installed can cause conflicts.

```sql
-- Example shape only; use the operator script to generate the complete list.
CREATE PUBLICATION boardsesh_pg18_migration FOR TABLE
  public.boardsesh_ticks,
  public.board_user_syncs;
```

The operator script generates the full table list from Neon, excluding system schemas and extension-owned tables.

**On Railway (subscriber):**

Load schema only before creating the subscription. The subscriber tables must
exist and should be empty. Pre-create `public` and `drizzle` on the target and
make `TARGET_OWNER_ROLE` their owner before filtering their `SCHEMA` entries
from the restore list; the guarded helper below performs that ownership step.

```bash
set +x
PGPASSFILE="$SOURCE_PGPASS_FILE" pg_dump -h "$SOURCE_HOST" -p "$SOURCE_PORT" \
  -U "$SOURCE_ADMIN_USER" -d railway \
  --schema-only --no-owner --no-acl --schema=public --schema=drizzle \
  --no-publications --no-subscriptions --format=custom \
  --file boardsesh-schema.dump
pg_restore --list boardsesh-schema.dump >boardsesh-schema.list
awk '$0 !~ / SCHEMA - / && $0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / { print }' \
  boardsesh-schema.list >boardsesh-schema.filtered.list
PGPASSFILE="$TARGET_PGPASS_FILE" pg_restore -h "$TARGET_HOST" -p "$TARGET_PORT" \
  -U "$TARGET_ADMIN_USER" -d railway --exit-on-error --schema-only --no-owner --no-acl \
  --role "$TARGET_OWNER_ROLE" \
  --use-list boardsesh-schema.filtered.list \
  boardsesh-schema.dump
```

`TARGET_OWNER_ROLE` must be a pre-created `NOLOGIN`, non-superuser application
owner with `CREATE` on the target database and ownership of pre-existing app
schemas such as `public`. Reapply and audit runtime grants/default privileges
separately; `--no-acl` intentionally does not preserve them.

Create the subscription only through the guarded operator helper below. It
builds the password-bearing `CONNECTION` clause in a mode `0600` temporary SQL
file, enables `standard_conforming_strings`, verifies the password-redacted
canonical conninfo, and removes the file on every exit. Do not paste a
replication URL into interactive SQL or shell history.

### 4.2 Operator Script

The repo includes a guarded helper for the setup and verification flow:

```bash
set +x
: "${NEON_DATABASE_URL:?inject from the secret manager}"
: "${RAILWAY_DATABASE_URL:?inject from the secret manager}"
: "${NEON_REPLICATION_DATABASE_URL:?inject from the secret manager}"
export TARGET_OWNER_ROLE='boardsesh_owner'
export TARGET_MIGRATOR_ROLE='boardsesh_migrator'
export TARGET_SUBSCRIBER_ROLE='boardsesh_pg18_subscriber'
export TARGET_RUNTIME_ROLE='boardsesh_runtime'
export TARGET_RUNTIME_SCHEMAS='public drizzle'
export TARGET_SNAPSHOT_FENCE_OWNER_ROLE='boardsesh_snapshot_fence_owner'
export SOURCE_DATABASE_NAME='railway'
export TARGET_DATABASE_NAME='railway'
export PUBLICATION_NAME='boardsesh_pg18_migration'
export SUBSCRIPTION_NAME='boardsesh_pg18_sub'
export SLOT_NAME='boardsesh_pg18_migration'
export INCLUDE_SCHEMAS='public drizzle'

scripts/postgres-logical-replication.sh setup
scripts/postgres-logical-replication.sh status
```

The `setup` command verifies `wal_level = logical`, creates the required Railway
extensions plus HypoPG only when it exists in the source extension manifest,
fails closed on source column ACLs that `--no-acl` cannot preserve, loads Neon
schema only, reconstructs the exact runtime ACL policy, verifies target app
tables are empty, creates/updates the Neon publication with app tables only,
and creates the Railway subscription with `copy_data = true`. It does not update
application environment variables.

`NEON_REPLICATION_DATABASE_URL` stays required for `status`, `sync-sequences`,
and `teardown`, because every command revalidates the password-redacted canonical
connection, exact publication, subscription owner/options/table set, and slot
contract before acting. `TARGET_OWNER_ROLE` and `TARGET_SUBSCRIBER_ROLE` are
required for `status` and `sync-sequences`; `teardown` demands them only for the
two steps that compare a role name against the catalog — dropping a live
subscription and dropping the temporary subscriber role — so the WAL-emergency
slot and publication cleanup in section 6.2 runs without them. `TARGET_RUNTIME_ROLE`, `TARGET_RUNTIME_SCHEMAS`, and
`TARGET_MIGRATOR_ROLE` are required for `setup`, where the helper reconstructs ACLs omitted by the
schema-only restore and verifies the exact two-direction role graph.

### 4.3 Verify Replication Is Streaming

On Neon, check that the subscription is active:

```sql
SELECT * FROM pg_stat_replication;
```

On Railway, check subscription status:

```sql
SELECT subname, received_lsn, latest_end_lsn, latest_end_time
FROM pg_stat_subscription;
```

Confirm the `received_lsn` is advancing. Also compare row counts on a few high-write tables (for example `boardsesh_ticks`, `board_user_syncs`, `comments`, `votes`, and `feed_items`) to make sure they match once initial sync finishes.

### 4.4 Monitor During Transition Window

Leave both databases running for a few hours to a day. Any writes to Neon (user syncs, new ticks, comments, follows) will replicate to Railway automatically. Check replication lag periodically:

```sql
-- On Railway
SELECT now() - latest_end_time AS replication_lag
FROM pg_stat_subscription
WHERE subname = 'boardsesh_pg18_sub';
```

Lag should be under a few seconds for our write volume.

### 4.5 Sequence Sync

Logical replication does not replicate sequences. Before cutover, sync sequence values from Neon to Railway so new inserts get the correct IDs:

`pg_sequences` does not expose `is_called`. The helper discovers sequences
owned by application-table columns, queries each sequence relation for its
actual `last_value`/`is_called` pair, applies all values in one target
transaction, and compares the resulting target state. A brand-new sequence has
`last_value = 1, is_called = false`; changing that flag skips its first ID.

The helper refuses to run until every named writer role is `NOLOGIN`, no session
for those roles remains, every subscription table is ready, and the subscriber
has reached a source flush LSN:

```bash
WRITES_FENCED=true \
FENCED_WRITER_ROLES='boardsesh_runtime boardsesh_sync boardsesh_migrator' \
  scripts/postgres-logical-replication.sh sync-sequences
```

## 5. Cutover Steps

1. Run `scripts/postgres-logical-replication.sh status` and confirm:
   - `Railway table sync states` shows `srsubstate = 'r'` (ready) for **all** rows. Anything else (`i` initialize, `d` data copy, `s` synchronizing) means initial sync is still running — do not proceed.
   - `replication_lag` on Railway is well under 1 second.
   - `Row count comparison` shows matching counts on the listed `CHECK_TABLES` (`boardsesh_ticks`, `board_user_syncs`, `comments`, `votes`, `feed_items`, `users`).
2. Stop every application, worker, cron, sync process, and migration job that can
   write to Neon. Revoke login from every writer role, terminate old sessions,
   and prove the source rejects a write using each runtime credential.
3. Sync sequences from Neon → Railway with the guarded command in section 4.5.
4. Run the full source/target data verifier described in the PG18 runbook.
5. Set `DATABASE_URL` in Vercel project settings to the Railway app/runtime connection string.
6. Update the Railway backend service `DATABASE_URL` env var to the Railway app/runtime connection string.
7. Deploy web + backend. The first successful Railway write is the forward-only rollback boundary.
8. Keep the old source fenced and monitor error rates, query latency, connections,
   replication-slot retention, disk, and backup success for 72 hours. Complete a
   successful PG18 backup and restore drill before removing the logical link.
   Specifically watch:
   - **Sentry** for HTTP 5xx, GraphQL resolver errors, and `prepared statement "X" already exists` (the canary signal that `prepare:false` regressed somewhere).
     - **TODO before cutover:** record the Sentry project URL / saved-search filter here.
   - **Vercel Functions** logs for elevated p95 latency on `/api/og/*`, `/api/internal/*`, and the climb-search SSR pages.
     - **TODO before cutover:** record the Vercel project / function-filter URL here.
   - **Railway PostgreSQL metrics** — connection count, CPU, query throughput, pgbouncer wait time.
     - **TODO before cutover:** record the Railway metrics dashboard URL here.
9. Only after that 72-hour acceptance window and successful restore drill, use
   the guarded helper to drop the Railway subscription, exact orphan source
   slot if necessary, and Neon publication. Do not substitute unchecked manual
   `DROP` statements: same-name objects are not sufficient proof that they
   belong to this migration. With every connection, role, database, schema,
   publication, subscription, and slot variable from section 4.2 still
   exported, run:

   ```bash
   set +x
   TEARDOWN_CONFIRMED=true \
   TARGET_OWNER_ROLE=boardsesh_owner \
   TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
   PUBLICATION_NAME=boardsesh_pg18_migration \
   SUBSCRIPTION_NAME=boardsesh_pg18_sub \
   SLOT_NAME=boardsesh_pg18_migration \
     scripts/postgres-logical-replication.sh teardown
   ```

   The two role names are repeated here because the normal path still has a live
   subscription and the temporary subscriber role to drop; section 6.2 covers the
   emergency case where only the slot and publication are left.

## 6. Rollback Procedure

- Keep Neon credentials saved. Do not delete the Neon project for at least 30 days after cutover.
- **Before the first Railway write:** keep Railway fenced, confirm Neon is still the
  sole writable database, and then a connection-string failback remains possible.
- **After the first Railway write:** do not point writers back at Neon and do not
  improvise reverse logical replication. PostgreSQL major-version logical
  replication is not a bidirectional failback protocol. Fix forward on Railway,
  or restore/reseed a PG18 target from the authoritative PG18 data. Never allow
  both databases to accept writes.

### 6.1 Pin Neon as Read-Only After Cutover

Once the app has been running cleanly on Railway for 24 hours, lock down Neon so a stale `.env`, forgotten cron, or rolled-back deploy cannot silently write back to the abandoned primary:

```sql
-- On Neon, with the role the app uses (substitute the actual app role name):
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE FROM app_user;
```

Or rotate the Neon password and replace it nowhere — accidental connections will fail loudly with an auth error rather than corrupting the snapshot you may need to restore from.

### 6.2 Aborted Setup: Manual Cleanup

If `setup` is interrupted after `CREATE SUBSCRIPTION` but before normal teardown
completes, Neon retains the logical-replication slot and accumulates WAL until
disk fills. Use the guarded teardown; it validates the exact subscription,
publication, remote slot, owner, options, tables, and password-redacted conninfo
before the first drop.

How far it gets depends on whether the Railway subscription is still there, and
the two outcomes are not interchangeable. Start with the block below either way:
it never mutates anything it has not first proven is ours, and its output names
the path you are on. Clearing an orphaned slot and publication needs nothing but
the three connection URLs, so this runs from a bare shell; every other name is
already the helper's default:

```bash
set +x
: "${NEON_DATABASE_URL:?inject from the secret manager}"
: "${RAILWAY_DATABASE_URL:?inject from the secret manager}"
: "${NEON_REPLICATION_DATABASE_URL:?inject from the secret manager}"
TEARDOWN_CONFIRMED=true \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_migration \
  scripts/postgres-logical-replication.sh teardown
```

**If the subscription was already gone**, that command drops the WAL retention.
The helper independently validates and drops only the exact inactive orphan slot,
then the publication, and only then exits non-zero with:

```
error: the replication objects are gone; export TARGET_OWNER_ROLE and TARGET_SUBSCRIBER_ROLE and re-run teardown to remove the temporary subscriber role
```

Neon has stopped accumulating WAL by the time you read that. The disk emergency
is over; re-run with both names set to finish the role cleanup. A same-name
object with different owner/options/publication/table/slot/connection metadata is
left untouched instead and requires manual investigation through a secret-safe
admin session.

**If the subscription is still present**, the same command mutates nothing at
all. Proving a live subscription belongs to this migration means comparing its
owner against `TARGET_SUBSCRIBER_ROLE`, so teardown stops before the first drop,
with the catalog — slot and publication included — exactly as it found it:

```
error: subscription boardsesh_pg18_sub still exists; proving it belongs to this migration needs TARGET_SUBSCRIBER_ROLE, and finishing the run needs TARGET_OWNER_ROLE for the role cleanup. Export both. Slot- and publication-only cleanup needs neither
```

That is the fail-closed answer, not a partial cleanup: Neon is still retaining
WAL, and re-running without the two names changes nothing. A subscription that
is still present is proved to belong to this migration by its owner, so that
step needs `TARGET_SUBSCRIBER_ROLE`; dropping the temporary subscriber role at
the end needs both names. A drifted subscriber role does not block any of it —
its privileges have no bearing on whether dropping the replication objects is
safe, so those go and the role is left for you to inspect.
Supply both and one pass clears everything:

```bash
set +x
TEARDOWN_CONFIRMED=true \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_migration \
  scripts/postgres-logical-replication.sh teardown
```

If the names went with the shell that ran `setup`, Railway still holds both. The
subscription's owner is `TARGET_SUBSCRIBER_ROLE`, and the single membership that
role carries with `SET`-only semantics names `TARGET_OWNER_ROLE` (its other
membership is `pg_create_subscription`). Read them through the same
`TARGET_PGPASS_FILE` admin connection section 4.1 set up, never a URL in argv:

```bash
set +x
PGPASSFILE="$TARGET_PGPASS_FILE" psql -X \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_ADMIN_USER" -d railway <<'SQL'
SELECT subscriber.rolname AS target_subscriber_role,
       granted.rolname    AS target_owner_role
FROM pg_subscription AS subscription
JOIN pg_roles AS subscriber ON subscriber.oid = subscription.subowner
JOIN pg_auth_members AS membership ON membership.member = subscriber.oid
JOIN pg_roles AS granted ON granted.oid = membership.roleid
WHERE subscription.subname = 'boardsesh_pg18_sub'
  AND membership.set_option
  AND NOT membership.inherit_option;
SQL
```

Feed those two values back into the block above. Do not reach for a hand-written
`DROP SUBSCRIPTION` instead — the helper's owner comparison is the only check
standing between this teardown and someone else's same-name object.

A plain `DROP SUBSCRIPTION` also has to reach Neon to drop the slot at the other
end, which is exactly what an operator running this section usually cannot do.
The helper disables the subscription, detaches it with
`ALTER SUBSCRIPTION ... SET (slot_name = NONE)`, and only then drops it, so the
drop is local to Railway; the slot is removed separately over the Neon admin
connection. Because those three statements autocommit one at a time, teardown
accepts the two half-finished shapes a failed run leaves behind — a disabled
subscription, or a disabled one whose `subslotname` is already NULL — and
finishes the job. Identity is unchanged: the subscription's name, owner,
publication list, connection digest and digest comment still all have to match
before anything is dropped, so a same-name subscription belonging to somebody
else is refused whether it is enabled or not.

Detaching also means the drop no longer cleans up after an initial copy that
never finished, so teardown sweeps the table-synchronization slots
(`pg_<oid>_sync_...`) itself, matching on the OID of the subscription it just
dropped. Those slots retain WAL exactly like the main one, and after a detached
drop nothing else would ever remove them.

If a walsender on Neon has not disconnected yet, teardown waits for it and then
stops with `source slot ... is still held by an active walsender`.
`SOURCE_SLOT_RELEASE_SECONDS` (default 60) is the budget for that waiting across
the whole run, not per slot: the migration slot and every stranded
table-synchronization slot draw from the same 60 seconds, so a teardown that
meets a dozen held sync slots still returns in about a minute rather than a
dozen. A dead replication socket can hold one open until Neon's
`wal_sender_timeout` expires; raise the budget past that rather than looping the
command, and write the new value without a leading zero: bash reads `090` as
octal, so teardown refuses it outright rather than waiting a number nobody asked
for. The subscription is already dropped by this point, so the re-run picks up
at the slot and the publication — expect it to say so, and treat the run as
unfinished until it exits clean. That re-run has no subscription left to match
sync slots against, so instead of dropping them it lists them under `cannot
attribute to any subscription`, finishes the safe publication cleanup, and
returns non-zero without removing the temporary subscriber role. Check that no
other subscriber on that database owns them and drop each one by hand:

```sql
SELECT pg_drop_replication_slot('pg_<oid>_sync_<relid>_<sysid>');
```

## 7. Homelab Read Replica Setup

### 7.1 PostgreSQL Installation

Physical streaming replication requires the same major version on both sides.
Provision the standby through the `blackheathdc-ansible` repository, using the exact
attested PG18.4/PostGIS artifact digest selected for Railway and a fresh PG18
parent volume. The role must inspect `PG_VERSION` and the image metadata before
start and fail closed on an existing PG16/PG17 cluster. A major-version change
requires a new base backup; it is never an in-place mount of the old volume.

### 7.2 Replication User on Railway

Do not create another generic `replicator` identity from this runbook. Reuse the
audited, pre-provisioned `boardsesh_standby` LOGIN REPLICATION role from the PG18
role contract. Its password and the capped physical slot are created only by the
later guarded homelab/Ansible stage, after PG18 has passed the 72-hour acceptance
and restore gates. Record that stage's exact slot name and retention cap before
taking the base backup; never create an uncapped ad-hoc slot interactively.

### 7.3 Network Connectivity

Pick one:

- **WireGuard tunnel** from homelab to Railway. Homelab initiates the connection, so no inbound port forwarding is needed. This is the simplest option.
- **Cloudflare Tunnel** for TCP proxying to Railway's PostgreSQL port.
- **Direct connection** if the homelab has a static IP. Add the IP to Railway's allowlist.

### 7.4 Initial Base Backup

The Ansible role must create a new, versioned volume, take `pg_basebackup` with
WAL streaming and `-R`, validate the backup manifest, then start the standby.
Do not manually clear a shared data directory. Keep the old volume detached and
recoverable until the new standby has passed replay, restart, and restore
rehearsals. `-R` writes `standby.signal` and the replication connection settings.

### 7.5 Streaming Replication Config

Verify or adjust the following in `postgresql.conf` on the homelab:

```
primary_conninfo = 'host=railway-host port=5432 user=boardsesh_standby sslmode=verify-full passfile=/run/credentials/postgres-replication.pgpass'
primary_slot_name = '<exact Ansible-managed capped physical slot>'
hot_standby = on
```

Check replication status from Railway:

```sql
SELECT * FROM pg_stat_replication;
```

Check replica lag from the homelab:

```sql
SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;
```

### 7.6 Application Read Routing

> [!CAUTION]
> Do not set `READ_REPLICA_URL` to the homelab standby for the current DR
> rollout. The application seam has no health-aware fallback to the primary, so
> a residential/tunnel outage would turn a healthy Railway primary into failed
> user reads. Keep it unset and treat the homelab as disaster recovery first.
> The only planned standby workload is the separately fenced offline snapshot
> exporter after the shadow/correctness gates in `docs/board-snapshots.md` pass.

The application has a `READ_REPLICA_URL` seam wired through `packages/db/src/client/postgres.ts`:

- `createReadDb()` / `createReadPool()` — return a `postgres-js` client pointed at `process.env.READ_REPLICA_URL`. When the env var is unset, both fall back to the primary singleton, so call sites don't need to branch and the seam is safe to merge before a replica exists.
- `closeReadPool()` — tears down the read client; called from the backend's shutdown path next to `closePool()`.
- Web entry points: `getReadDb`, `getReadPool` (re-exported from `packages/web/app/lib/db/db.ts`), plus the `dbzRead` drizzle singleton.
- Backend entry point: `dbRead` (exported from `packages/backend/src/db/client.ts`).

To turn the homelab replica on for application reads, set `READ_REPLICA_URL` in Vercel project settings (and on the Railway backend service) to a connection string pointing at the homelab — typically a private endpoint reached via WireGuard / Cloudflare Tunnel as in section 7.3. The replica uses postgres-js with `prepare: false` just like the primary, so it works whether the homelab sits behind PgBouncer or accepts direct connections.

**Routed to the replica today** (see `git log` on these files for exact commits):

- `packages/web/app/lib/db/queries/climbs/search-climbs.ts` — climb-search SSR (`cachedSearchClimbs`).
- `packages/backend/src/db/queries/climbs/search-climbs.ts` — GraphQL `searchClimbs` resolver.
- `packages/web/app/lib/db/queries/climbs/holds-heatmap.ts` — heatmap stats.
- `packages/web/app/api/internal/prewarm-heatmap/[board_name]/route.ts` — heatmap warm-up cron.
- `packages/web/app/lib/seo/dynamic-og-data.ts` — OG profile/setter/session/playlist summary queries.
- `packages/web/app/api/og/profile/route.tsx` — OG profile per-grade tick aggregation.
- `packages/backend/src/graphql/resolvers/social/session-feed.ts` — session-grouped activity feed.

**Kept on primary:**

- Auth (`/api/auth/*`) and session reads/writes.
- All write paths — `boardsesh_ticks` insert/update, profile edits, comments, votes, follows, party-mode `board_sessions` writes.
- Board sync daemons (`packages/aurora-sync/`, `packages/kilter-sync/`, run as CLIs on a VM) — credentials and sync-status writes are write-heavy and must read their own writes.
- Backend GraphQL resolvers other than the read-only feed/search.
- `packages/db/scripts/*` — one-shot CLIs target the direct primary URL.

When adding new read paths, default to `getReadDb()` / `dbRead` for stale-tolerant reads (analytics, public profile views, search). Reach for the primary `getDb()` / `db` only when reads need to see the caller's just-written data, or when the data is auth-sensitive.

### 7.7 DR Failover

If Railway goes down:

1. Fence every Railway writer and prove the old primary cannot accept writes. If
   Railway cannot be fenced, do not promote the homelab standby writable.
2. Confirm replay lag, the last received/replayed LSN, backup freshness, and the
   complete writer inventory in the incident checklist.
3. Promote through the Ansible/incident procedure, then update all application,
   worker, cron, and migration credentials together.
4. Treat the homelab database as the new authority after its first write. Rebuild
   Railway as a standby from it; do not reconnect the old Railway primary as a
   writer or attempt ad hoc reverse replication.

## 8. Verification Checklist

### Pre-cutover (while Railway is still a replica)

- [ ] Railway schema-only restore completes without errors
- [ ] Logical replication subscription is active and streaming
- [ ] Initial table sync is complete (`pg_subscription_rel` states are ready)
- [ ] Replication lag is under a few seconds
- [ ] Row counts match between Neon and Railway on high-write tables
- [ ] Extensions verified: `SELECT * FROM pg_extension;` shows postgis, uuid-ossp, pg_trgm
- [ ] Sequences synced from Neon to Railway

### Post-cutover

- [ ] `DATABASE_URL` updated in Vercel and Railway backend service
- [ ] Web app loads and serves pages correctly
- [ ] Climb search works
- [ ] User auth (login/signup) works
- [ ] Party/session mode works (WebSocket backend)
- [ ] Aurora sync runs successfully
- [ ] OG image generation works (`/api/og/climb`, `/api/og/profile`)
- [ ] Subscription dropped on Railway, publication dropped on Neon
- [ ] No Neon references remain in codebase: `grep -r "neondatabase" packages/`

## 9. Cost Comparison

| Item               | Neon (Before)  | Railway (After)                   |
| ------------------ | -------------- | --------------------------------- |
| Database hosting   | $50-100/mo     | ~$5-20/mo (existing subscription) |
| Connection pooling | Included       | Add PgBouncer only if needed      |
| Read replica       | Extra cost     | $0 (homelab)                      |
| **Total**          | **$50-100/mo** | **$5-20/mo**                      |
