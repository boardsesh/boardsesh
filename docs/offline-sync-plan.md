# Offline Sync Plan

Offline data layer for the React Native mobile app. Uses `expo-sqlite` for the local database with a custom GraphQL mutation queue for offline writes. Can optionally ship a pre-warmed SQLite database as an app asset for instant offline browsing of a board's climbs — but the asset is optional and default builds omit it (see status below).

This document records the evaluation of four approaches and why `expo-sqlite` + custom mutation queue is the recommendation. The plan was refined through 4 rounds of review by paired Opus agents (8 review agents total, 100+ findings).

## Status — shipped vs deferred (PR #2277)

PR #2277 lands the offline write path and the opt-in board-sync machinery. The pre-warmed seed asset is wired as an **optional** code path, not shipped as a bundled file.

**Shipped:**

- **Phase 2 backend sync resolvers** — per-table cursor-paginated `sync*` queries + `syncDeletions`, with the composite cursor indexes the resolvers range-scan.
- **On-device write-through queue** — `pending_mutations` table, FIFO drainer with backoff, atomic dead-letter transition, dead-letter retry/discard.
- **Dual-write user writes** — ticks and favorites land in both local SQLite and the backend; the 1-by-1 sync runner pushes the queue immediately when online.
- **Optional seed asset (code path only)** — `initializeDatabase` attempts to load a bundled `boardsesh-seed.db` and, if present and the board tables are empty, copies its board reference rows in (via SQLite `ATTACH`) and stamps each board's checkpoint from the seed's build cursor. With no asset, the app runs online-only. There is **no seed asset file in the repo** — only the load path. Default builds resolve "no seed" through `src/db/seed-asset.ts`, which keeps a `require('…seed.db')` literal out of the default Metro graph (a literal `require` of a missing file fails `expo export`).
- **Per-board opt-in sync + status UI** — a "Board data (offline)" section in Settings toggles `syncEnabledBoards` per board (with a download-size warning before enabling), and a live status row shows sync progress + "last synced …" threaded from `pullSync`'s `onProgress` callback through a module-level `sync-status` store.

**Deferred (tracked follow-ups):**

- **The actual pre-warmed asset build pipeline** — a reproducible job that snapshots the board tables into `boardsesh-seed.db` (plus its `seed_checkpoints` cursor table) and an EAS build profile / Play Asset Delivery package that bundles it. The seed remains **optional**: it is a first-launch head start, never a requirement.
- **Local-SQLite climb-search repoint** — climb search still queries GraphQL; pointing the search JOINs at the local board tables (so a downloaded board searches fully offline) is the tracked next step.

## Alternatives evaluated

### WatermelonDB — rejected

Reviewed by two Opus agents (30 general findings, 3 dealbreakers):

1. **Soft delete required.** WatermelonDB's sync protocol requires the server to report deleted record IDs. Adding `deleted_at` columns to 5 tables means modifying 120+ existing query sites and rebuilding unique indexes as partial indexes.
2. **Maintenance risk.** Single-maintainer project (Nozbe). Last release (v0.28) over a year ago. Known React Native New Architecture compatibility issues (GitHub #1851).
3. **Single global sync timestamp.** `synchronize()` uses one `lastPulledAt` for all tables. Per-board selective sync needs per-board timestamps.

### PowerSync self-hosted — rejected

Reviewed by two Opus agents (2 dealbreakers, 5 serious risks):

1. **Infrastructure cost.** Self-hosted PowerSync service + MongoDB = ~$70/mo on Railway.
2. **Composite PK incompatibility.** 15+ tables have composite or integer PKs. PowerSync requires a single text `id` column. Every Sync Rule and client query needs synthetic ID construction.
3. **Pre-warmed database is complex.** PowerSync's sync state uses Postgres LSN, not timestamps. No documented API to inject a pre-built database with correct sync metadata.
4. **Replication slot risk.** If PowerSync goes down, WAL accumulates in Postgres and can fill disk.
5. **MongoDB ops burden.** 3-node replica set management, initialization, backups, monitoring.

### RxDB + custom GraphQL sync — rejected

Reviewed by two Opus agents (1 dealbreaker, 4 serious risks):

1. **No JOINs.** RxDB is a document database that stores JSON blobs in SQLite rows. The core climb search query JOINs `board_climbs` with `board_climb_stats` — this is fundamentally relational. With RxDB, every search requires two collection queries + JavaScript-level merge and sort. Unacceptable for 200K+ climbs.
2. **Pre-warmed database complexity.** Building a valid RxDB SQLite requires running a full RxDB instance, inserting 500K+ documents through its API (4 SQLite writes per document for indexes). No public `setCheckpoint()` API to initialize replication state.
3. **Missing `updated_at` columns.** 8 of the syncable tables lack the `updated_at` column that sync pull queries depend on.
4. **`toggleFavorite` is a toggle, not idempotent.** Incompatible with sync push (a retry would invert the state).

### expo-sqlite + custom mutation queue — recommended

The original plan from [mobile-app-plan.md](mobile-app-plan.md) Phase 5. After evaluating all alternatives, this is the best fit for Boardsesh's data model.

**Why it wins:**

| Concern             | expo-sqlite + mutation queue                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Climb search        | Full SQL with JOINs, proper column indexes, < 100ms                                                                                                 |
| Infrastructure cost | $0 — client-only, uses existing GraphQL API                                                                                                         |
| Pre-warmed database | Just a SQLite file. No internal metadata, no LSN alignment, no RxDB format. Copy to disk and open.                                                  |
| Backend changes     | Sync pull queries (10 resolvers) + `sync_deletions` table + idempotent mutations                                                                    |
| Delete handling     | `sync_deletions` table + triggers. Existing queries untouched.                                                                                      |
| Maintenance risk    | `expo-sqlite` is a first-party Expo module. Guaranteed New Architecture support.                                                                    |
| Custom code         | Mutation queue (~800-1200 lines including error handling, retry logic, cache invalidation), sync pull client (~200 lines). Well-understood pattern. |

## Architecture

```
React Native App
  ├── Pre-warmed SQLite (ships with app, all boards, ~150-200MB)
  ├── expo-sqlite manages the database
  ├── TanStack Query for reactive data + cache (staleTime: Infinity for local queries)
  ├── Mutation queue for offline writes
  └── Sync pull client for incremental updates
        │
        │ GraphQL mutations (push) + sync queries (pull)
        ▼
Hono Backend (minimal changes)
  ├── Existing mutations: saveTick (+ client UUID), createPlaylist (+ client UUID)
  ├── New mutations: addFavorite, removeFavorite
  ├── New sync pull queries: syncTicks, syncClimbs, syncClimbStats, etc.
  ├── New table: sync_deletions (tracks hard deletes for sync)
  └── Writes to Postgres
        │
        ▼
PostgreSQL (Railway, unchanged)
```

No additional services. No MongoDB. No replication slots. Sync happens directly between the mobile app and the existing GraphQL API.

## Pre-warmed SQLite database

The app ships with a CI-built SQLite database containing all board reference data (~150-200MB compressed). All boards are browsable offline from first launch.

### Build pipeline

```
GitHub Action (on schema change + weekly)
  ├── Query Postgres for all board reference data
  ├── Build SQLite database with proper schema (columns, indexes)
  ├── Run on-device migration scripts to match current app schema version
  ├── Record the build timestamp in a metadata table
  ├── Compress and include as Expo asset
  └── Commit to the mobile app repo
```

This is just a SQLite file — no RxDB internal format, no PowerSync metadata, no LSN tracking. The schema matches the client's expected tables and columns exactly.

### On first launch

1. Copy the pre-warmed SQLite from app assets to the writable documents directory.
2. Run any pending on-device schema migrations (in case the app is newer than the pre-warmed DB).
3. Open with `expo-sqlite`.
4. All board reference data is immediately available. Full SQL with JOINs.
5. Start the sync pull client to fetch changes since the pre-warmed timestamp.

### App size

| Content                          | Compressed size |
| -------------------------------- | --------------- |
| App binary (RN + native modules) | ~30 MB          |
| Pre-warmed database (all boards) | ~150-200 MB     |
| **Total**                        | **~180-230 MB** |

Use Play Asset Delivery on Android (APK limit is 150MB).

### Staleness

Pre-warmed data is as fresh as the last CI build (weekly + on schema change). New climbs appear once the sync pull client fetches incremental updates. First sync after launch fetches changes since the build timestamp.

### Schema migration across embedded + live databases

When a Drizzle migration adds a column, three things must stay in sync:

1. **Postgres migration** — runs via `vp run db:migrate` on deploy.
2. **Pre-warmed SQLite** — rebuilt weekly by the CI Action.
3. **On-device SQLite** — must be migrated on app startup if the app schema is newer than the local database.

The on-device migration system runs sequentially on app startup, checking the database's schema version against the app's expected version. If the pre-warmed DB was built before the latest migration, the startup migration brings it forward. If a sync pull query returns a column that doesn't exist locally, the migration adds it.

## Climb search — full SQL with JOINs

The core advantage of expo-sqlite over every alternative evaluated:

```sql
SELECT c.uuid, c.name, c.setter_username, c.frames, c.frames_count,
       c.edge_left, c.edge_right, c.edge_bottom, c.edge_top,
       cs.display_difficulty, cs.quality_average, cs.ascensionist_count,
       cs.benchmark_difficulty, cs.fa_username
FROM board_climbs c
LEFT JOIN board_climb_stats cs ON c.uuid = cs.climb_uuid AND cs.angle = ?
WHERE c.board_type = ? AND c.is_listed = 1
  AND c.layout_id = ?
  AND (? IS NULL OR cs.display_difficulty BETWEEN ? AND ?)
ORDER BY cs.quality_average DESC NULLS LAST
LIMIT 50 OFFSET ?
```

This runs against proper SQLite columns with covering indexes — not JSON blob extraction. Target: < 100ms p95 on 200K climbs.

The pre-warmed database includes indexes matching the web app's query patterns:

```sql
CREATE INDEX idx_climbs_search ON board_climbs (board_type, layout_id, is_listed);
CREATE INDEX idx_stats_lookup ON board_climb_stats (board_type, climb_uuid, angle);
CREATE INDEX idx_stats_difficulty ON board_climb_stats (board_type, angle, display_difficulty);
```

## Mutation queue — offline writes

A FIFO queue for offline mutations. Estimated ~800-1200 lines of production-quality code including: queue infrastructure, per-entity handlers, error classification, retry limits, dead letter handling, TanStack Query cache invalidation, network/foreground listeners, and concurrent drain protection.

### How it works

1. User creates a tick offline → written to local SQLite immediately.
2. TanStack Query cache is invalidated (specific query keys per entity type) → UI updates instantly.
3. The mutation is added to a `pending_mutations` table in SQLite.
4. When online, the queue drainer processes mutations in order, calling GraphQL mutations.
5. Processed mutations are removed from the queue.
6. Failed mutations are retried up to `MAX_RETRY_COUNT` (10), then moved to dead letter state.

### Mutation queue schema

```sql
CREATE TABLE pending_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,     -- 'create', 'update', 'delete'
  payload TEXT NOT NULL,       -- JSON payload for the mutation
  idempotency_key TEXT NOT NULL UNIQUE, -- client-generated UUID
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 10,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending' -- 'pending', 'dead_letter'
);
```

### Queue drainer

```typescript
const MAX_RETRY_COUNT = 10;
let isDraining = false;

async function drainMutationQueue(db: SQLiteDatabase) {
  if (isDraining) return; // concurrent drain protection
  isDraining = true;

  try {
    const pending = await db.getAllAsync<PendingMutation>(
      `SELECT * FROM pending_mutations
       WHERE status = 'pending'
       ORDER BY created_at ASC LIMIT 10`,
    );

    for (const mutation of pending) {
      try {
        await processMutation(mutation);
        await db.runAsync('DELETE FROM pending_mutations WHERE id = ?', mutation.id);
      } catch (error) {
        if (isRetryable(error)) {
          const newRetryCount = mutation.retry_count + 1;
          if (newRetryCount >= MAX_RETRY_COUNT) {
            await db.runAsync(`UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE id = ?`, [
              error.message,
              mutation.id,
            ]);
          } else {
            await db.runAsync(`UPDATE pending_mutations SET retry_count = ?, last_error = ? WHERE id = ?`, [
              newRetryCount,
              error.message,
              mutation.id,
            ]);
          }
          break; // stop processing, retry later
        }
        // Non-retryable (validation error, 404, 409): move to dead letter
        await db.runAsync(`UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE id = ?`, [
          error.message,
          mutation.id,
        ]);
      }
    }
  } finally {
    isDraining = false;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof GraphQLError) {
    const status = error.extensions?.status;
    if (status === 401) return true; // auth expired, will refresh and retry
    if (status >= 500) return true; // server error, transient
    return false; // 4xx validation, 409 conflict — non-retryable
  }
  return false;
}

async function processMutation(mutation: PendingMutation) {
  const payload = JSON.parse(mutation.payload);

  switch (mutation.table_name) {
    case 'boardsesh_ticks':
      if (mutation.operation === 'create') {
        await graphql('saveTick', { input: { uuid: mutation.idempotency_key, ...payload } });
      } else if (mutation.operation === 'update') {
        await graphql('updateTick', { uuid: payload.uuid, input: payload });
      } else if (mutation.operation === 'delete') {
        await graphql('deleteTick', { uuid: payload.uuid });
      }
      break;

    case 'user_favorites':
      if (mutation.operation === 'create') {
        await graphql('addFavorite', { input: payload });
      } else if (mutation.operation === 'delete') {
        await graphql('removeFavorite', { input: payload });
      }
      break;

    case 'playlists':
      if (mutation.operation === 'create') {
        await graphql('createPlaylist', { input: { uuid: mutation.idempotency_key, ...payload } });
      } else if (mutation.operation === 'update') {
        await graphql('updatePlaylist', { input: payload });
      } else if (mutation.operation === 'delete') {
        await graphql('deletePlaylist', { playlistUuid: payload.uuid });
      }
      break;

    case 'playlist_climbs':
      if (mutation.operation === 'create') {
        await graphql('addClimbToPlaylist', { input: payload });
      } else if (mutation.operation === 'delete') {
        await graphql('removeClimbFromPlaylist', { input: payload });
      }
      break;

    case 'user_follows':
      await graphql(mutation.operation === 'create' ? 'followUser' : 'unfollowUser', {
        input: { userId: payload.followingId },
      });
      break;

    case 'setter_follows':
      await graphql(mutation.operation === 'create' ? 'followSetter' : 'unfollowSetter', {
        input: { setterUsername: payload.setterUsername },
      });
      break;

    case 'playlist_follows':
      await graphql(mutation.operation === 'create' ? 'followPlaylist' : 'unfollowPlaylist', {
        input: { playlistUuid: payload.playlistUuid },
      });
      break;

    case 'user_playlist_pins':
      if (mutation.operation === 'create') {
        await graphql('pinPlaylist', { input: { playlistUuid: payload.playlistUuid } });
      } else if (mutation.operation === 'delete') {
        await graphql('unpinPlaylist', { input: { playlistUuid: payload.playlistUuid } });
      }
      break;
  }
}
```

### Queue trigger points

| Trigger           | When                                    |
| ----------------- | --------------------------------------- |
| App foreground    | `AppState` listener, debounced          |
| After local write | Immediate attempt, then debounced retry |
| Network restored  | `NetInfo` listener                      |
| Pull-to-refresh   | User-initiated                          |

### Idempotency

Each mutation gets a client-generated UUID as an idempotency key. The backend's `saveTick` and `createPlaylist` accept this UUID and use `ON CONFLICT (uuid) DO NOTHING` for safe retry. Favorites use explicit `addFavorite`/`removeFavorite` (not `toggleFavorite`) so retries don't invert state. Follow/unfollow operations are naturally idempotent (follow when already following = no-op, unfollow when not following = no-op).

### Dead letter handling

Mutations that exceed `MAX_RETRY_COUNT` or fail with non-retryable errors are moved to `status = 'dead_letter'`. The app shows a badge/indicator when dead-letter mutations exist. Users can view failed mutations and choose to retry or discard them. This prevents silent data loss — the user always knows if a tick didn't sync.

## Sync pull — incremental updates

A pull client that fetches changes since the last sync checkpoint using a composite cursor to avoid timestamp collision bugs.

### Composite cursor — avoiding the bulk-update bug

Aurora sync bulk-updates thousands of `board_climb_stats` rows in a single transaction. They all get the same `NOW()` timestamp. If the sync pull used `WHERE updated_at > $since` alone, rows sharing a timestamp with the cursor boundary would be silently skipped.

The fix: use a composite cursor `(updated_at, id)` with row-value comparison:

```sql
WHERE (updated_at, id) > ($since_ts, $since_id)
ORDER BY updated_at ASC, id ASC
LIMIT 500
```

This guarantees no rows are skipped regardless of timestamp collisions. For tables with composite PKs (like `board_climb_stats`), a sequential `sync_seq` column (bigserial) is added as the cursor's second component instead of `id`.

### Pull queries (new GraphQL resolvers on the backend)

```graphql
type SyncCursor {
  updatedAt: DateTime!
  syncSeq: String! # stringified bigint for the sequential cursor component
}

type SyncResult {
  documents: [JSON!]!
  cursor: SyncCursor!
  hasMore: Boolean!
}

type Query {
  syncTicks(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncPlaylists(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncPlaylistClimbs(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncFavorites(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncUserFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncSetterFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncPlaylistFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncClimbs(boardType: String!, cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncClimbStats(boardType: String!, cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncDeletions(cursor: SyncCursorInput, limit: Int! = 500): SyncDeletionsResult!
}
```

Each resolver queries Postgres using the composite cursor:

```sql
-- syncTicks resolver
SELECT *, id AS sync_seq FROM boardsesh_ticks
WHERE user_id = $userId
  AND (updated_at, id) > ($since_ts, $since_seq)
ORDER BY updated_at ASC, id ASC
LIMIT $limit;

-- syncClimbStats resolver (uses sync_seq bigserial, not composite PK)
SELECT *, sync_seq FROM board_climb_stats
WHERE board_type = $boardType
  AND (updated_at, sync_seq) > ($since_ts, $since_seq)
ORDER BY updated_at ASC, sync_seq ASC
LIMIT $limit;
```

### Per-board selective sync

User data (ticks, playlists, favorites, follows) syncs always. Board reference data syncs per-board based on user settings. Checkpoints are keyed by `(tableName, boardType)` — not just `tableName` — so enabling Tension after syncing Kilter starts Tension from the pre-warmed timestamp, not from Kilter's checkpoint.

```typescript
const enabledBoards = getMMKVPreference<string[]>('sync_boards') ?? [];

// Sync user data (always)
await syncTable(db, 'boardsesh_ticks', 'syncTicks');
await syncTable(db, 'playlists', 'syncPlaylists');
await syncTable(db, 'playlist_climbs', 'syncPlaylistClimbs');
await syncTable(db, 'user_favorites', 'syncFavorites');
await syncTable(db, 'user_follows', 'syncUserFollows');
await syncTable(db, 'setter_follows', 'syncSetterFollows');
await syncTable(db, 'playlist_follows', 'syncPlaylistFollows');
await syncTable(db, 'board_climb_aliases', 'syncClimbAliases');

// Sync reference data for enabled boards only
for (const boardType of enabledBoards) {
  await syncTable(db, 'board_climbs', 'syncClimbs', { boardType });
  await syncTable(db, 'board_climb_stats', 'syncClimbStats', { boardType });
}
```

### Pull client implementation

```typescript
async function syncTable(
  db: SQLiteDatabase,
  tableName: string,
  queryName: string,
  extraVars?: Record<string, unknown>,
) {
  const checkpointKey = extraVars?.boardType ? `${tableName}:${extraVars.boardType}` : tableName;
  let cursor = await getCheckpoint(db, checkpointKey);
  let hasMore = true;

  while (hasMore) {
    const result = await graphql(queryName, {
      cursor,
      limit: 500,
      ...extraVars,
    });

    const { documents, cursor: newCursor, hasMore: more } = result;

    if (documents.length === 0) break;

    // Use smaller transaction batches to minimize write lock duration
    for (const batch of chunk(documents, 50)) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        for (const doc of batch) {
          await tx.runAsync(`INSERT OR REPLACE INTO ${tableName} (...) VALUES (...)`, mapDocToColumns(tableName, doc));
        }
      });
    }

    await setCheckpoint(db, checkpointKey, newCursor);
    cursor = newCursor;
    hasMore = more;
  }

  // After sync pull, invalidate relevant TanStack Query keys
  invalidateQueriesForTable(tableName);
}
```

## Delete handling — sync_deletions table

One new table with per-table trigger variants. Existing queries untouched — no soft-delete migration.

```sql
CREATE TABLE sync_deletions (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  record_id text NOT NULL,  -- uuid or id::text or composite PK concatenation
  user_id text,             -- scoped by user for privacy (NULL for reference data)
  deleted_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_deletions_user_since ON sync_deletions (user_id, deleted_at);
```

### Per-table trigger functions

Different tables use different identifier columns:

```sql
-- For tables with uuid + user_id (boardsesh_ticks, playlists)
CREATE FUNCTION log_deletion_uuid() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, OLD.user_id);
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ticks_delete AFTER DELETE ON boardsesh_ticks
  FOR EACH ROW EXECUTE FUNCTION log_deletion_uuid();
CREATE TRIGGER trg_playlists_delete AFTER DELETE ON playlists
  FOR EACH ROW EXECUTE FUNCTION log_deletion_uuid();

-- For tables with integer id + user_id (user_favorites)
CREATE FUNCTION log_deletion_id_user() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.id::text, OLD.user_id);
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_favorites_delete AFTER DELETE ON user_favorites
  FOR EACH ROW EXECUTE FUNCTION log_deletion_id_user();
CREATE TRIGGER trg_pins_delete AFTER DELETE ON user_playlist_pins
  FOR EACH ROW EXECUTE FUNCTION log_deletion_id_user();

-- For follow tables (integer id + follower_id as the user column)
CREATE FUNCTION log_deletion_follow() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.id::text, OLD.follower_id);
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_follows_delete AFTER DELETE ON user_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_follow();
CREATE TRIGGER trg_setter_follows_delete AFTER DELETE ON setter_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_follow();
CREATE TRIGGER trg_playlist_follows_delete AFTER DELETE ON playlist_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_follow();

-- For playlist_climbs (integer id, no direct user_id — resolve via playlist ownership)
CREATE FUNCTION log_deletion_playlist_climb() RETURNS TRIGGER AS $$
DECLARE
  owner_id text;
BEGIN
  SELECT po.user_id INTO owner_id
  FROM playlist_ownership po
  WHERE po.playlist_id = OLD.playlist_id
  LIMIT 1;
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.id::text, owner_id);
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON playlist_climbs
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climb();

-- For board_climb_stats (composite PK, no user — reference data deletion)
CREATE FUNCTION log_deletion_climb_stats() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME,
    OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
    NULL);
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_climb_stats_delete AFTER DELETE ON board_climb_stats
  FOR EACH ROW EXECUTE FUNCTION log_deletion_climb_stats();
```

The `syncDeletions` pull query is scoped by user (for user data) and includes reference data deletions (where `user_id IS NULL`):

```sql
SELECT table_name, record_id, deleted_at, id AS sync_seq
FROM sync_deletions
WHERE (user_id = $userId OR user_id IS NULL)
  AND (deleted_at, id) > ($since_ts, $since_seq)
ORDER BY deleted_at ASC, id ASC
LIMIT $limit;
```

Periodic cleanup: `DELETE FROM sync_deletions WHERE deleted_at < NOW() - INTERVAL '90 days'`.

## Backend changes needed

### Prerequisites (database migrations)

1. **`updated_at` columns on 8 tables.** Each needs a `TIMESTAMP DEFAULT NOW()` column, a `BEFORE UPDATE` trigger to auto-set it on every write, and a backfill of existing rows.

   Tables and their writers:

   | Table                | Writers                                                                             | Backfill from                         |
   | -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
   | `user_favorites`     | `toggleFavorite` mutation only                                                      | `created_at`                          |
   | `user_follows`       | `followUser`/`unfollowUser` only                                                    | `created_at`                          |
   | `setter_follows`     | `followSetter`/`unfollowSetter` only                                                | `created_at`                          |
   | `playlist_follows`   | `followPlaylist`/`unfollowPlaylist` only                                            | `created_at`                          |
   | `user_playlist_pins` | `pinPlaylist`/`unpinPlaylist` only                                                  | `created_at`                          |
   | `playlist_climbs`    | `addClimbToPlaylist` + FK cascade                                                   | `added_at`                            |
   | `board_climbs`       | Aurora sync, Kilter sync, climb mutations                                           | `created_at` (text → timestamp parse) |
   | `board_climb_stats`  | Aurora sync, Kilter sync, `recomputeClimbStats` (3 concurrent writers with raw SQL) | `NOW()`                               |

   The `BEFORE UPDATE` trigger ensures all writers (including raw SQL) set `updated_at` automatically:

   ```sql
   CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
   BEGIN
     NEW.updated_at = NOW();
     RETURN NEW;
   END; $$ LANGUAGE plpgsql;

   CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON board_climb_stats
     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
   -- Repeat for all 8 tables
   ```

2. **`sync_seq` bigserial on `board_climb_stats`.** This table has a composite PK `(board_type, climb_uuid, angle)` with no sequential column. The composite cursor needs a sequential component. Add `sync_seq BIGSERIAL` and index it alongside `updated_at`.

3. **`sync_deletions` table** with per-table trigger functions (5 variants: uuid+user_id, id+user_id, id+follower_id, playlist_climb ownership lookup, composite PK for stats).

4. **Idempotent mutations.** `saveTick` and `createPlaylist` accept an optional client-supplied `uuid` field. When provided, use it instead of server-generated UUID. Add `ON CONFLICT (uuid) DO NOTHING` to the insert. Existing web callers that don't send a UUID continue to work unchanged (server generates one).

5. **New `addFavorite` / `removeFavorite` mutations.** Replace `toggleFavorite` in the sync path. `addFavorite` uses `INSERT ... ON CONFLICT DO NOTHING` (idempotent). `removeFavorite` uses `DELETE ... WHERE` (idempotent — deleting nonexistent row is a no-op). The web app can keep using `toggleFavorite` or migrate to the new pair.

6. **`board_climb_aliases` sync.** Add `board_climb_aliases` to the synced tables so the mobile app can resolve duplicate Kilter UUIDs to canonical climb UUIDs.

### New GraphQL resolvers (10)

`syncTicks`, `syncPlaylists`, `syncPlaylistClimbs`, `syncFavorites`, `syncUserFollows`, `syncSetterFollows`, `syncPlaylistFollows`, `syncClimbs`, `syncClimbStats`, `syncDeletions` — each returns records using the composite cursor `(updated_at, id/sync_seq)`, scoped by user for user data, by `board_type` for reference data.

## React integration

### TanStack Query for local SQLite queries

TanStack Query works as a reactive wrapper around local SQLite queries. Set `staleTime: Infinity` for local queries (the data is always fresh — it's on disk). Invalidate manually after sync pulls and local writes.

```typescript
function useTicksForClimb(climbUuid: string, boardType: string) {
  const db = useSQLiteDatabase();
  return useQuery({
    queryKey: ['ticks', climbUuid, boardType],
    queryFn: () =>
      db.getAllAsync('SELECT * FROM boardsesh_ticks WHERE climb_uuid = ? AND board_type = ? ORDER BY climbed_at DESC', [
        climbUuid,
        boardType,
      ]),
    staleTime: Infinity, // local data, never stale — invalidate explicitly
  });
}

function useClimbSearch(boardType: string, angle: number, filters: SearchFilters) {
  const db = useSQLiteDatabase();
  return useQuery({
    queryKey: ['climb-search', boardType, angle, filters],
    queryFn: () =>
      db.getAllAsync(
        `SELECT c.*, cs.display_difficulty, cs.quality_average, cs.ascensionist_count
       FROM board_climbs c
       LEFT JOIN board_climb_stats cs ON c.uuid = cs.climb_uuid AND cs.angle = ?
       WHERE c.board_type = ? AND c.is_listed = 1
       AND (? IS NULL OR cs.display_difficulty BETWEEN ? AND ?)
       ORDER BY cs.quality_average DESC NULLS LAST
       LIMIT 50`,
        [angle, boardType, filters.minGrade, filters.minGrade, filters.maxGrade],
      ),
    staleTime: Infinity,
  });
}
```

### Cache invalidation after sync and writes

```typescript
function invalidateQueriesForTable(tableName: string) {
  switch (tableName) {
    case 'boardsesh_ticks':
      queryClient.invalidateQueries({ queryKey: ['ticks'] });
      queryClient.invalidateQueries({ queryKey: ['logbook'] });
      break;
    case 'board_climbs':
    case 'board_climb_stats':
      queryClient.invalidateQueries({ queryKey: ['climb-search'] });
      break;
    case 'playlists':
    case 'playlist_climbs':
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      break;
    case 'user_favorites':
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      break;
    // ... follows, pins
  }
}
```

### Writing records offline

```typescript
async function saveTick(db: SQLiteDatabase, tickData: TickInput) {
  const tickUuid = crypto.randomUUID();

  // 1. Write to local SQLite immediately
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status,
     attempt_count, quality, difficulty, comment, climbed_at, is_mirror, is_benchmark,
     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      tickUuid,
      tickData.boardType,
      tickData.climbUuid,
      tickData.angle,
      tickData.status,
      tickData.attemptCount,
      tickData.quality,
      tickData.difficulty,
      tickData.comment ?? '',
      new Date().toISOString(),
      tickData.isMirror ? 1 : 0,
      tickData.isBenchmark ? 1 : 0,
    ],
  );

  // 2. Queue the mutation for server sync
  await db.runAsync(
    `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key)
     VALUES ('boardsesh_ticks', 'create', ?, ?)`,
    [JSON.stringify(tickData), tickUuid],
  );

  // 3. Invalidate specific TanStack Query keys
  queryClient.invalidateQueries({ queryKey: ['ticks'] });
  queryClient.invalidateQueries({ queryKey: ['logbook'] });

  // 4. Attempt immediate sync
  drainMutationQueue(db);
}
```

## What stays the same

| Component             | Status                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `react-native-mmkv`   | KV preferences: active board, theme, onboarding, enabled boards list                                          |
| TanStack Query        | Data fetching + cache for both local SQLite and network-only data                                             |
| GraphQL subscriptions | Real-time party mode: queue sync, session events, driver control                                              |
| `expo-secure-store`   | Auth tokens in iOS Keychain / Android Keystore                                                                |
| Backend GraphQL API   | Mostly unchanged. New sync pull queries + sync_deletions + idempotent mutations + addFavorite/removeFavorite. |
| Aurora sync daemon    | Unchanged. Picks up ticks without `aurora_id` and pushes to Aurora API.                                       |

## Account lifecycle

On logout or account switch:

1. Cancel any in-progress sync pull or mutation queue drain.
2. Delete user data tables from SQLite (`boardsesh_ticks`, `playlists`, `playlist_climbs`, `user_favorites`, `user_follows`, `setter_follows`, `playlist_follows`, `user_playlist_pins`, `pending_mutations`). Board reference data stays — no need to re-copy the 150-200MB pre-warmed database.
3. Clear the TanStack Query cache.
4. On new login, sync pull client fetches the new user's data (small, seconds).

## Performance targets

| Metric                   | Target                | Notes                                     |
| ------------------------ | --------------------- | ----------------------------------------- |
| Climb search (local SQL) | < 100ms p95           | Full SQL with JOINs, covering indexes     |
| Tick write (offline)     | < 10ms                | SQLite INSERT + mutation queue entry      |
| Incremental sync         | < 2s typical          | GraphQL pull, paginated, composite cursor |
| App launch (pre-warmed)  | < 1s to first content | Database already populated                |
| Memory (idle)            | < 5MB for SQLite      | On disk, not in memory                    |

## Risks

| Risk                                                      | Likelihood | Impact | Mitigation                                                                                                 |
| --------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Mutation queue complexity higher than estimated           | Certain    | Medium | Budget 800-1200 lines. Well-understood pattern, no architectural risk.                                     |
| Pre-warmed DB too large for app stores                    | Medium     | Medium | Use Play Asset Delivery on Android. App Store allows 200MB cellular. Fallback: lazy-fetch `frames` column. |
| `updated_at` on multi-writer tables (`board_climb_stats`) | Certain    | Low    | Postgres `BEFORE UPDATE` trigger handles all writers transparently, including raw SQL.                     |
| Schema migration drift (Postgres vs on-device SQLite)     | Medium     | Medium | On-device migration system runs on app startup. Pre-warmed DB rebuild triggered on schema changes.         |
| Dead-letter mutations accumulate                          | Low        | Low    | UI indicator + user action (retry/discard). Telemetry to track frequency.                                  |
| Sync pull misses data                                     | Low        | Low    | Composite cursor `(updated_at, sync_seq)` eliminates timestamp collision bugs.                             |

## Implementation timeline

### Phase 2 — backend prerequisites (part of Core experience, +3 days)

- `updated_at` column migration on 8 tables + `BEFORE UPDATE` triggers.
- `sync_seq` bigserial on `board_climb_stats`.
- `sync_deletions` table + per-table trigger functions.
- Sync pull resolvers (10 new GraphQL queries with composite cursor).
- Idempotent mutations: `saveTick`/`createPlaylist` accept optional client UUID.
- New `addFavorite`/`removeFavorite` mutations.

### Phase 5 — client-side offline (Platform features, within the 3-week phase)

- Pre-warmed SQLite database build pipeline (GitHub Action).
- On-device schema migration system.
- Mutation queue (~800-1200 lines) with queue drainer, error classification, dead letter handling.
- Sync pull client with composite cursor and per-board checkpoints.
- TanStack Query integration with `staleTime: Infinity` for local queries.
- Per-board sync toggle UI.
- Sync status indicator ("last synced X minutes ago").
- Dead-letter mutation indicator.

## Verification

### Offline tick flow

1. Put device in airplane mode.
2. Open a climb, record a tick.
3. Verify tick appears immediately in the logbook (TanStack Query invalidation).
4. Restore network. Wait for mutation queue to drain.
5. Verify tick appears in the web app's logbook.

### Server-to-mobile sync

1. Log a tick on the web app.
2. Trigger sync pull on mobile (pull-to-refresh or app foreground).
3. Verify the tick appears in the mobile logbook.

### Climb search performance

1. Pre-warm database with 200K Kilter climbs + stats.
2. Run climb search with difficulty filter + quality sort.
3. Verify < 100ms on iPhone 13.

### Board selective sync

1. Enable Kilter for incremental sync. Verify checkpoint key is `board_climbs:kilter`.
2. Add a new climb on web. Trigger sync. Verify it appears on mobile.
3. Enable Tension. Verify Tension sync starts from pre-warmed timestamp, not Kilter's checkpoint.
4. Disable Kilter sync. Add another climb. Verify it does NOT sync.
5. Browse Kilter climbs in airplane mode — pre-warmed data still available.

### Mutation queue resilience

1. Create 10 ticks offline. Verify all appear in local SQLite.
2. Reconnect. Verify all 10 are pushed via GraphQL mutations.
3. Kill the app mid-push (after tick #5). Relaunch. Verify ticks #6-10 are pushed on retry (idempotent — #1-5 deduplicated via UUID).
4. Create a tick with a nonexistent `climb_uuid`. Verify it's moved to dead letter and subsequent mutations still process.
5. Verify dead-letter indicator appears in the UI.

### Timestamp collision (composite cursor)

1. Bulk-update 1000 `board_climb_stats` rows with the same timestamp (simulate Aurora sync).
2. Run sync pull with limit 500. Verify all 1000 rows are eventually fetched across two pages.
3. Verify no rows are silently skipped.

### Delete sync

1. Delete a tick on web. Verify `sync_deletions` trigger fires with correct `record_id` and `user_id`.
2. Delete a playlist (cascades to `playlist_climbs`). Verify both the playlist and its climbs appear in `sync_deletions`.
3. Sync pull on mobile. Verify both are removed from local SQLite.

### Schema migration

1. Add a column to `boardsesh_ticks` via Drizzle migration.
2. Deploy to Postgres. Pre-warmed DB is NOT rebuilt yet (simulates weekly lag).
3. Launch the app. Verify on-device migration adds the new column.
4. Sync pull returns rows with the new column. Verify they INSERT correctly.
