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
psql "$RAILWAY_DATABASE_URL" -c "SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;"
```

If `usesuper` is `f`, use the Railway `postgres` superuser connection string for the setup script and switch back to the app role after teardown.

Create a publication for application tables. Do not use `FOR ALL TABLES` here: PostGIS installs extension-owned tables such as `spatial_ref_sys`, and copying those into a Railway database that already has PostGIS installed can cause conflicts.

```sql
-- Example shape only; use the operator script to generate the complete list.
CREATE PUBLICATION boardsesh_migration FOR TABLE
  public.boardsesh_ticks,
  public.board_user_syncs;
```

The operator script generates the full table list from Neon, excluding system schemas and extension-owned tables.

**On Railway (subscriber):**

Load schema only before creating the subscription. The subscriber tables must exist and should be empty:

```bash
pg_dump --schema-only --no-owner --no-acl --no-publications --no-subscriptions --format=custom \
  --file boardsesh-schema.dump "$NEON_DATABASE_URL"
pg_restore --list boardsesh-schema.dump >boardsesh-schema.list
awk '$0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / { print }' \
  boardsesh-schema.list >boardsesh-schema.filtered.list
pg_restore --schema-only --no-owner --no-acl \
  --role "$TARGET_OWNER_ROLE" \
  --use-list boardsesh-schema.filtered.list \
  --dbname "$RAILWAY_DATABASE_URL" boardsesh-schema.dump
```

`TARGET_OWNER_ROLE` must be a pre-created `NOLOGIN`, non-superuser application
owner with `CREATE` on the target database and ownership of pre-existing app
schemas such as `public`. Reapply and audit runtime grants/default privileges
separately; `--no-acl` intentionally does not preserve them.

Create a subscription pointing back at Neon. Use the Neon replication role connection string for `CONNECTION`:

```sql
CREATE SUBSCRIPTION boardsesh_neon_sub
  CONNECTION 'postgresql://user:pass@neon-host/dbname?sslmode=require'
  PUBLICATION boardsesh_migration
  WITH (copy_data = true);
```

### 4.2 Operator Script

The repo includes a guarded helper for the setup and verification flow:

```bash
export NEON_DATABASE_URL='postgresql://...'
export RAILWAY_DATABASE_URL='postgresql://...'
export NEON_REPLICATION_DATABASE_URL='postgresql://replication-user:...'
export TARGET_OWNER_ROLE='boardsesh_owner'
export TARGET_SUBSCRIBER_ROLE='boardsesh_pg18_subscriber'

scripts/neon-to-railway-replication.sh setup
scripts/neon-to-railway-replication.sh status
```

The `setup` command verifies `wal_level = logical`, creates Railway extensions, loads Neon schema only, verifies target app tables are empty, creates/updates the Neon publication with app tables only, and creates the Railway subscription with `copy_data = true`. It does not update application environment variables.

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
WHERE subname = 'boardsesh_neon_sub';
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
  scripts/neon-to-railway-replication.sh sync-sequences
```

## 5. Cutover Steps

1. Run `scripts/neon-to-railway-replication.sh status` and confirm:
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
9. Only after that 72-hour acceptance window and successful restore drill, drop
   the subscription on Railway and publication on Neon. The manual SQL and the
   helper are equivalent destructive paths; neither bypasses the acceptance gate.

   On Railway:

   ```sql
   ALTER SUBSCRIPTION boardsesh_neon_sub DISABLE;
   DROP SUBSCRIPTION boardsesh_neon_sub;
   ```

   On Neon:

   ```sql
   DROP PUBLICATION boardsesh_migration;
   ```

   Or use:

   ```bash
   TEARDOWN_CONFIRMED=true scripts/neon-to-railway-replication.sh teardown
   ```

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

If `setup` is interrupted after `CREATE SUBSCRIPTION` but before normal teardown completes, Neon retains the logical-replication slot and accumulates WAL until disk fills. Drop the subscription on Railway (this auto-drops the corresponding slot on Neon):

```bash
psql "$RAILWAY_DATABASE_URL" -c "DROP SUBSCRIPTION IF EXISTS boardsesh_neon_sub;"
# Verify the slot is gone on Neon:
psql "$NEON_DATABASE_URL" -c "SELECT slot_name, slot_type FROM pg_replication_slots;"
```

If the slot persists on Neon (subscription was disconnected before drop), drop it manually:

```bash
psql "$NEON_DATABASE_URL" -c "SELECT pg_drop_replication_slot('boardsesh_neon_sub');"
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

Connect to Railway's PostgreSQL and create a replication role:

```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'secure-password-here';
```

Create a replication slot for the homelab replica:

```sql
SELECT pg_create_physical_replication_slot('homelab_replica');
```

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
primary_conninfo = 'host=railway-host port=5432 user=replicator sslmode=verify-full passfile=/run/credentials/postgres-replication.pgpass'
primary_slot_name = 'homelab_replica'
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
