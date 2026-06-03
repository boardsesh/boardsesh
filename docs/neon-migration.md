# Neon to Railway PostgreSQL Migration Runbook

Migration from Neon PostgreSQL to Railway PostgreSQL with a homelab read replica.

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
pg_restore --schema-only --no-owner --no-acl \
  --dbname "$RAILWAY_DATABASE_URL" boardsesh-schema.dump
```

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

```sql
-- Generate this on Neon:
SELECT format(
  'SELECT setval(%L, %s, %L);',
  quote_ident(s.sequence_schema) || '.' || quote_ident(s.sequence_name),
  ps.last_value,
  ps.is_called
)
FROM information_schema.sequences s
JOIN pg_sequences ps ON ps.schemaname = s.sequence_schema AND ps.sequencename = s.sequence_name
WHERE s.sequence_schema NOT IN ('pg_catalog', 'information_schema');
```

`is_called` matters: a brand-new sequence has `last_value = 1, is_called = false`, meaning the next `nextval()` returns 1. Hardcoding `true` on a never-used sequence would skip its first ID.

Run the output on Railway.

The helper script can do this directly:

```bash
scripts/neon-to-railway-replication.sh sync-sequences
```

## 5. Cutover Steps

1. Run `scripts/neon-to-railway-replication.sh status` and confirm:
   - `Railway table sync states` shows `srsubstate = 'r'` (ready) for **all** rows. Anything else (`i` initialize, `d` data copy, `s` synchronizing) means initial sync is still running — do not proceed.
   - `replication_lag` on Railway is well under 1 second.
   - `Row count comparison` shows matching counts on the listed `CHECK_TABLES` (`boardsesh_ticks`, `board_user_syncs`, `comments`, `votes`, `feed_items`, `users`).
2. Sync sequences from Neon → Railway (section 4.5).
3. Set `DATABASE_URL` in Vercel project settings to the Railway app/runtime connection string.
4. Update the Railway backend service `DATABASE_URL` env var to the Railway app/runtime connection string.
5. Deploy web + backend.
6. On Railway, drop the subscription (it's no longer needed):
   ```sql
   ALTER SUBSCRIPTION boardsesh_neon_sub DISABLE;
   DROP SUBSCRIPTION boardsesh_neon_sub;
   ```
7. On Neon, drop the publication:
   ```sql
   DROP PUBLICATION boardsesh_migration;
   ```
   Or use:
   ```bash
   scripts/neon-to-railway-replication.sh teardown
   ```
8. Monitor error rates and query latency for 24-48 hours. Specifically watch:
   - **Sentry** for HTTP 5xx, GraphQL resolver errors, and `prepared statement "X" already exists` (the canary signal that `prepare:false` regressed somewhere).
     - **TODO before cutover:** record the Sentry project URL / saved-search filter here.
   - **Vercel Functions** logs for elevated p95 latency on `/api/og/*`, `/api/internal/*`, and the climb-search SSR pages.
     - **TODO before cutover:** record the Vercel project / function-filter URL here.
   - **Railway PostgreSQL metrics** — connection count, CPU, query throughput, pgbouncer wait time.
     - **TODO before cutover:** record the Railway metrics dashboard URL here.

## 6. Rollback Procedure

- Keep Neon credentials saved. Do not delete the Neon project for at least 30 days after cutover.
- **Before dropping the subscription** (step 5.6): rollback is instant — just flip `DATABASE_URL` back to Neon and redeploy. Neon still has all the data since it was the primary.
- **After dropping the subscription**: flip `DATABASE_URL` back to Neon, but any writes that happened on Railway after cutover won't be on Neon. For a quick rollback, set up reverse logical replication (Railway → Neon) before deleting the Neon project. For the volume of writes we get, a few hours of lost data is recoverable from Aurora sync re-import.

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

Install PostgreSQL **at the same major version** Railway is running. Physical streaming replication via `pg_basebackup` requires identical major versions on primary and standby — a 17 → 18 mismatch fails on startup. Whenever Railway upgrades the major version, the homelab replica must be re-baselined at the new version (drop, reinstall the matching `postgresql-N` packages, redo section 7.4).

```bash
sudo apt install postgresql-17 postgresql-17-postgis-3
```

Then in `psql`:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

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

Stop PostgreSQL on the homelab, clear the data directory, and take a base backup:

```bash
sudo systemctl stop postgresql
sudo rm -rf /var/lib/postgresql/17/main/*

pg_basebackup -h railway-host -p 5432 -U replicator \
  -D /var/lib/postgresql/17/main -Fp -Xs -P -R

sudo chown -R postgres:postgres /var/lib/postgresql/17/main
sudo systemctl start postgresql
```

The `-R` flag writes `standby.signal` and sets `primary_conninfo` in `postgresql.auto.conf`.

### 7.5 Streaming Replication Config

Verify or adjust the following in `postgresql.conf` on the homelab:

```
primary_conninfo = 'host=railway-host port=5432 user=replicator password=xxx sslmode=require'
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

1. Promote the homelab replica:
   ```bash
   pg_ctl promote -D /var/lib/postgresql/17/main
   ```
2. Update `DATABASE_URL` in Vercel and the backend service to point at the homelab.
3. Accept higher latency temporarily (AU to global users).
4. Once Railway recovers, re-establish replication in the opposite direction or re-baseline from the homelab.

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
