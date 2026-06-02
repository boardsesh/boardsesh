# Aurora Sync

This document describes how Aurora board data (Kilter, Tension) is synced from the Aurora Climbing API to the Boardsesh database.

## Overview

The `@boardsesh/aurora-sync` package provides the shared sync implementation. It can run:

1. **CLI** - For local debugging and manual sync runs
2. **OS-level service / Railway backend** - Long-running daemon that picks one user per cycle, syncs their per-user tables, then runs a board-wide shared sync using their fresh Aurora token
3. **Vercel** - (Removed) Previously a daily `/api/internal/shared-sync/tension` cron; shared sync now piggybacks on user sync inside the daemon

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  External Cron  │────▶│  Railway Backend │────▶│   Neon (Prod)   │
│  (cron-job.org) │     │  POST /sync-cron │     │    Database     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌──────────────────┐
                        │   Aurora API     │
                        │  (Kilter/Tension)│
                        └──────────────────┘
```

## How Sync Works

### 1. Credential Retrieval

- Fetch all users with stored Aurora credentials from `aurora_credentials` table
- Decrypt username/password using `AURORA_CREDENTIALS_SECRET`

### 2. Authentication

- Login to Aurora API to get fresh session token
- Store encrypted token for future use

### 3. Incremental Sync

- Request data from Aurora `/sync` endpoint with last sync timestamps
- Aurora returns only data changed since last sync
- Uses `_complete` flag for pagination of large datasets

### 4. Database Writes

- **Batched inserts** (100 rows per batch) for performance
- **Fresh pool per sync** to avoid Neon WebSocket timeouts
- **Dual-write** for certain tables:
  - `ascents` → `kilter_ascents` + `boardsesh_ticks`
  - `bids` → `kilter_bids` + `boardsesh_ticks`
  - `circuits` → `kilter_circuits` + `playlists` + `playlist_climbs`

### Tables Synced

#### Per-user tables

| Aurora Table | Local Table                        | Dual Write                 |
| ------------ | ---------------------------------- | -------------------------- |
| users        | kilter_users / tension_users       | -                          |
| walls        | kilter_walls / tension_walls       | -                          |
| ascents      | kilter_ascents / tension_ascents   | boardsesh_ticks            |
| bids         | kilter_bids / tension_bids         | boardsesh_ticks            |
| tags         | kilter_tags / tension_tags         | -                          |
| circuits     | kilter_circuits / tension_circuits | playlists, playlist_climbs |
| draft_climbs | kilter_climbs / tension_climbs     | -                          |

#### Shared (board-wide) tables

After every successful per-user sync, the daemon also runs a shared sync for that user's board, reusing the user's just-refreshed Aurora token. This replaces the old Vercel `/api/internal/shared-sync/<board>` cron and the per-board `*_SYNC_TOKEN` env vars (`KILTER_SYNC_TOKEN`, `TENSION_SYNC_TOKEN`, `DECOY_SYNC_TOKEN`, `TOUCHSTONE_SYNC_TOKEN`, `GRASSHOPPER_SYNC_TOKEN`) — those env vars can be removed from the Vercel project settings.

| Aurora Table               | Local Table                        |
| -------------------------- | ---------------------------------- |
| products                   | board_products                     |
| sets                       | board_sets                         |
| product_sizes              | board_product_sizes                |
| holes                      | board_holes                        |
| layouts                    | board_layouts                      |
| placement_roles            | board_placement_roles              |
| leds                       | board_leds                         |
| placements                 | board_placements                   |
| product_sizes_layouts_sets | board_product_sizes_layouts_sets   |
| climbs                     | board_climbs (+ board_climb_holds) |
| climb_stats                | board_climb_stats (+ history)      |
| beta_links                 | board_beta_links                   |
| attempts                   | board_attempts                     |
| kits                       | board_kits                         |

When the climbs upsert sees previously-unseen UUIDs, the daemon also writes `new_climbs_synced` rows into the `notifications` table for each follower of the climb's setter (`setter_follows` and any linked `user_follows` accounts).

### `board_climb_stats`: two-writer model

`ascensionist_count` is the materialized sum of two source columns, each
owned by a single writer:

| Column                         | Owner                           | Updated by                                                                                                                |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `aurora_ascensionist_count`    | Aurora sync                     | `upsertClimbStats` (this file's daemon) — written verbatim from Aurora's payload                                          |
| `boardsesh_ascensionist_count` | Boardsesh `recomputeClimbStats` | `packages/backend/src/graphql/resolvers/ticks/recompute-climb-stats.ts` — `COUNT(DISTINCT user_id)` over flash/send ticks |
| `ascensionist_count`           | Both writers, kept in lockstep  | Every `upsertClimbStats` and every `recomputeClimbStats` recompute it as `COALESCE(aurora,0) + COALESCE(boardsesh,0)`     |

The search hot path reads `ascensionist_count` through the covering index from
migration 0067, so it stays a regular column (not `GENERATED`) — both writers
must update it whenever they touch their own share.

`fa_username` / `fa_at` follow a related but asymmetric rule. Aurora's upsert
writes them verbatim (including `null`, which is how Aurora signals an FA
correction). `recomputeClimbStats` only re-derives FA for
Boardsesh-originated climbs (`board_climbs.user_id IS NOT NULL`); on Aurora
climbs it does `COALESCE(existing, agg.first_user)` so Aurora's authority is
never disturbed. Boardsesh-created climbs aren't synced from Aurora, so the
two paths can't collide.

`quality_average`, `difficulty_average`, and `display_difficulty` follow the
same Boardsesh-owned rule. Aurora's upsert clobbers them on every sync from
the much larger Aurora ascent population. `recomputeClimbStats` only writes
these columns for Boardsesh-originated climbs (where Aurora never syncs);
on Aurora climbs it leaves them untouched so Aurora's averages stay
authoritative. `display_difficulty` mirrors `difficulty_average` in both
writers (Aurora: `Number(item.display_difficulty || item.difficulty_average)`;
Boardsesh: the same `AVG(bt.difficulty)` value used for `difficulty_average`).

If you add a new writer to `board_climb_stats`, decide which side it owns and
recompute `ascensionist_count` in the same statement that updates that side.

## CLI Usage

### Installation

The CLI is available via the `@boardsesh/aurora-sync` package:

```bash
# From repo root
bunx tsx packages/aurora-sync/src/cli/index.ts <command>

# Or after build
bunx aurora-sync <command>
```

### Commands

```bash
# Sync all users with active credentials
aurora-sync all
aurora-sync all -v  # Verbose output

# Run the one-user daemon with Sydney quiet hours
aurora-sync daemon
aurora-sync daemon -v  # Verbose output

# Sync specific user
aurora-sync user <nextauth-user-id> -b kilter
aurora-sync user <nextauth-user-id> -b tension -v

# List stored credentials
aurora-sync list
```

### Environment Variables

```bash
DATABASE_URL="postgresql://..."
AURORA_CREDENTIALS_SECRET="<encryption key>"
```

### Using 1Password CLI

Create `.env.1password`:

```
DATABASE_URL="op://Boardsesh/Postgres PROD/connection_string"
AURORA_CREDENTIALS_SECRET="op://Boardsesh/Encryption key/password"
```

Run with:

```bash
op run --env-file=packages/aurora-sync/.env.1password -- bunx aurora-sync all -v
op run --env-file=packages/aurora-sync/.env.1password -- bunx aurora-sync daemon -v
```

### Daemon Mode

- `aurora-sync daemon` runs forever and syncs exactly one user per cycle.
- The daemon picks the user with the oldest `lastSyncAt`, with `NULL` values first.
- Between cycles it waits a random `1` to `15` minutes.
- It does not sync between `10:00 PM` and `7:00 AM` in `Australia/Sydney`, but the process stays alive and checks again every minute.
- Aurora HTTP, timeout, network, and rate-limit failures are treated as transient and retried later without marking the credential as errored.

## Railway Deployment

### 1. Environment Variables

Add to Railway service:

| Variable                    | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `DATABASE_URL`              | Neon PostgreSQL connection string               |
| `AURORA_CREDENTIALS_SECRET` | Same key as Vercel (for decrypting credentials) |
| `CRON_SECRET`               | New secret for authenticating cron requests     |

### 2. Endpoint

The backend exposes:

```
POST /sync-cron
Authorization: Bearer <CRON_SECRET>
```

Response:

```json
{
  "success": true,
  "results": {
    "total": 3,
    "successful": 3,
    "failed": 0
  },
  "errors": [],
  "timestamp": "2024-01-02T12:00:00.000Z"
}
```

### 3. External Cron Setup

Use [cron-job.org](https://cron-job.org) or similar:

- **URL**: `https://<railway-app>.up.railway.app/sync-cron`
- **Method**: POST
- **Headers**: `Authorization: Bearer <CRON_SECRET>`
- **Schedule**: Every 15 minutes (or as needed)

### 4. Monitoring

Check Railway logs for sync output:

```
[Sync] Starting sync cron job...
[SyncRunner] Found 3 users with Aurora credentials to sync
[SyncRunner] ✓ Successfully synced user xxx for kilter
[SyncRunner] ✓ Successfully synced user xxx for tension
[Sync] Completed: 3/3 users synced successfully
```

## Performance Optimizations

### Batched Inserts

Instead of inserting rows one-by-one, we batch 100 rows per INSERT:

```sql
INSERT INTO kilter_ascents (uuid, climb_uuid, ...)
VALUES (...), (...), (...)
ON CONFLICT (uuid) DO UPDATE SET ...
```

### Fresh Pool Per Sync

Neon's serverless WebSocket connections can timeout on long operations. We create a fresh connection pool for each user sync and close it immediately after:

```typescript
const pool = createFreshPool();
try {
  await syncUserData(pool, ...);
} finally {
  await pool.end();
}
```

### HTTP Driver for Simple Queries

For simple SELECT/UPDATE queries that don't need transactions, we use Neon's HTTP driver which is more reliable:

```typescript
const db = createHttpDb();
await db.select().from(auroraCredentials)...
```

## Troubleshooting

### Connection Timeout Errors

```
Error: Connection terminated unexpectedly
```

- Usually caused by stale WebSocket connections
- The fresh pool pattern should prevent this
- If persists, check Neon dashboard for connection limits

### Decryption Errors

```
Failed to decrypt credentials
```

- Verify `AURORA_CREDENTIALS_SECRET` matches the key used to encrypt
- Check that the secret hasn't been rotated

### No Data Synced

- Check `aurora-sync list` to verify credentials exist
- Verify user has `syncStatus: active` or `error` (not `disabled`)
- Check Aurora API is accessible from the environment

## JSON Export Import (Alternative to API Sync)

Since the Kilter backend has been shut down, API-based sync is no longer available for Kilter users. As an alternative, users can import their data from Aurora's JSON export file.

### How It Works

1. User downloads their data export from Aurora (a `.json` file)
2. In Boardsesh Settings > Board Accounts, click **Import JSON** on the relevant board card
3. Select the export file — a preview shows the number of ascents, attempts, and circuits
4. Confirm — the server resolves climb names to UUIDs, maps grades, and imports the data

### Technical Details

- **Endpoint**: `POST /api/internal/aurora-import`
- **Implementation**: `packages/web/app/lib/data-sync/aurora/json-import.ts`
- **UI**: Import button in `packages/web/app/components/settings/aurora-credentials-section.tsx`

### Key Differences from API Sync

|                  | API Sync                     | JSON Import                               |
| ---------------- | ---------------------------- | ----------------------------------------- |
| Data identifiers | Aurora UUIDs                 | Climb names (resolved to UUIDs)           |
| Grade format     | Numeric difficulty IDs       | Font grade strings ("6c")                 |
| Quality/stars    | 0-3 scale (internal)         | 1-5 scale (user-facing)                   |
| Dedup key        | Aurora UUID (`auroraId`)     | Deterministic hash (`json-import-{hash}`) |
| Trigger          | Automatic (cron every 15min) | Manual (user uploads file)                |

### Deduplication

- **Same file re-imported**: Deterministic `auroraId` based on `sha256(climbUuid:angle:climbedAt:type)` ensures `onConflictDoUpdate` handles idempotency.
- **Cross-source (API + JSON)**: Before inserting, existing ticks are fetched and matched by `(climbUuid, angle, climbedAt)` with normalized timestamps. Matching entries are skipped.

### Climb Name Resolution

Climb names are resolved via `board_climbs` table using a composite index on `(board_type, name)`. When multiple climbs share the same name (rare), the one with the highest `ascensionist_count` is chosen.

Unresolvable names (delisted climbs, typos) are returned to the user in the result dialog so they know which entries could not be imported.

## Migration from Vercel Cron

After Railway sync is working:

1. Monitor Railway logs to confirm syncs complete successfully
2. Compare sync timestamps between Vercel and Railway
3. Disable Vercel cron route (`/api/internal/user-sync-cron`)
4. Remove the route file after confirming Railway works

### Kilter sync allowlist (interim)

While Kilter sync is in early access, the connect endpoint is gated by `KILTER_SYNC_ALLOWED_USER_IDS`. Set it to a comma-separated list of NextAuth user IDs (e.g. `KILTER_SYNC_ALLOWED_USER_IDS=user_abc,user_def`); any user not on the list gets a 403 when they try to connect their Kilter account. The value is read once at module load, so rotating the list (adding a beta tester, removing someone) requires a redeploy of any service that imports the gate — there is no hot reload. The gate goes away when we ship general availability; tracking work to remove it lives in PR 15 of the kilter-sync rollout series.

## See also

- [`kilter-sync.md`](./kilter-sync.md) — Sibling package for the Kilter Grips integration. Same `aurora_credentials` table, same daemon shape, completely different wire (Keycloak OAuth + PowerSync NDJSON + REST).
