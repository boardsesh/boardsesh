# Aurora Sync

This document describes how Aurora board data (Kilter, Tension) is synced from the Aurora Climbing API to the Boardsesh database.

## Overview

The `@boardsesh/aurora-sync` package provides a shared sync implementation that can run:

1. **CLI** - For local debugging and manual sync runs
2. **Railway Backend** - HTTP endpoint triggered by external cron
3. **Vercel** - (Legacy) Will be removed after Railway migration

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

#### Per-user sync (`@boardsesh/aurora-sync`, runs on each user's credentials)

| Aurora Table | Local Table                        | Dual Write                 |
| ------------ | ---------------------------------- | -------------------------- |
| users        | kilter_users / tension_users       | -                          |
| walls        | kilter_walls / tension_walls       | -                          |
| ascents      | kilter_ascents / tension_ascents   | boardsesh_ticks            |
| bids         | kilter_bids / tension_bids         | boardsesh_ticks            |
| tags         | kilter_tags / tension_tags         | -                          |
| circuits     | kilter_circuits / tension_circuits | playlists, playlist_climbs |
| draft_climbs | kilter_climbs / tension_climbs     | -                          |

#### Shared sync (Vercel cron, `/api/internal/shared-sync/[board_name]`)

Driven by `packages/web/app/lib/data-sync/aurora/shared-sync.ts`. Hits Aurora's
`/sync` endpoint on a per-board service token (no user credentials), upserts
hardware and content tables that all users see.

| Aurora Table                | Local Table (unified)          | Notes                                              |
| --------------------------- | ------------------------------ | -------------------------------------------------- |
| products                    | board_products                 | Parent of size/layout/role/hole tables             |
| sets                        | board_sets                     | -                                                  |
| product_sizes               | board_product_sizes            | FK → board_products                                |
| holes                       | board_holes                    | FK → board_products                                |
| layouts                     | board_layouts                  | FK → board_products                                |
| placement_roles             | board_placement_roles          | FK → board_products                                |
| leds                        | board_leds                     | FK → board_product_sizes, board_holes              |
| product_sizes_layouts_sets  | board_product_sizes_layouts_sets | FK → board_product_sizes, board_layouts, board_sets |
| climbs                      | board_climbs                   | -                                                  |
| climb_stats                 | board_climb_stats              | -                                                  |
| beta_links                  | board_beta_links               | -                                                  |
| attempts                    | board_attempts                 | -                                                  |

**Iteration order:** the Aurora API request still uses `SHARED_SYNC_TABLES`
(matches the Android app's order to stay indistinguishable), but upserts run
in `PROCESSING_ORDER` (FK-safe) so a fresh sync can populate parents before
children. Drizzle multi-row `INSERT … ON CONFLICT (board_type, id) DO UPDATE
SET … = excluded.…` is used in batches of 100.

**Known gaps** (in `SHARED_SYNC_TABLES` but not processed today):

- `placements` — `board_placements` schema exists but there is no `Placement`
  Aurora API type, and Aurora's `SyncDataPUT` does not include placements.
- `products_angles` — API type exists but no `board_products_angles` schema.
- `kits` — neither type nor schema.

If Aurora ever ships rows for one of these and we start seeing FK errors,
add an upsert + schema alongside the others.

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
