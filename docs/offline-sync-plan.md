# Offline Sync Plan

Offline data layer for the React Native mobile app. Uses `expo-sqlite` for the local database with a custom GraphQL mutation queue for offline writes.

> **Shipped design supersedes the "pre-warmed, ships with the app" plan below.** This document is the original architecture evaluation (four approaches compared, one recommended) plus a first-cut design for warming boards on-device. What actually shipped downloads reference data **per board scope, on demand**, warmed by a nightly-built, CDN-hosted SQLite snapshot per `(boardType, layoutId)` rather than a single all-boards database bundled into the app binary. See **[`board-snapshots.md`](board-snapshots.md)** for the shipped export job, artifact format, client bootstrap flow, and ops runbook. The alternatives evaluation, mutation queue, sync pull protocol, and table manifest still describe the shipped system accurately; the "Pre-warmed SQLite database" section, app-size/QA notes, and any "first sync" / "pre-warmed timestamp" references describe the superseded all-boards-in-binary design.

> **Which surfaces read offline, and from where.** This document covers the sync engine — how rows get onto the phone. What decides whether a given screen renders from SQLite, from an allowlisted persisted query cache, or from an honest "no signal" state is a separate call, recorded in **[`offline-reads.md`](offline-reads.md)** along with the auth-scoping contract every local read has to satisfy.

> **Where the code lives.** The engine (mutation queue + drainer, pull client, checkpoints, table config, SQLite DDL/migrations) is the platform-free package **`@boardsesh/offline-sync`** (`packages/shared/offline-sync`). The mobile app binds its platform seams — expo-sqlite handle, NetInfo/AppState triggers, `onlineManager` connectivity, Sentry telemetry — in `packages/mobile/src/offline/offline-sync-adapter.ts`; mobile code calls `drainMutationQueue`/`startSyncScheduler`/`triggerSync`/`pullSync` via that adapter only, never from the package directly. Expo-specific pieces (DB lifecycle/`connection.ts`, local read queries, the sync-status store, hooks, the bridge component) stay in `packages/mobile`.

This document records the evaluation of four approaches and why `expo-sqlite` + custom mutation queue is the recommendation. The plan was refined through 4 rounds of review by paired Opus agents (8 review agents total, 100+ findings).

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

The original plan from the mobile app plan's Phase 5 (doc since retired). After evaluating all alternatives, this is the best fit for Boardsesh's data model.

**Why it wins:**

| Concern             | expo-sqlite + mutation queue                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Climb search        | Full SQL with JOINs, proper column indexes, < 100ms                                                                                                 |
| Infrastructure cost | $0 — client-only, uses existing GraphQL API                                                                                                         |
| Snapshot bootstrap  | Plain SQLite artifacts. No internal metadata, no LSN alignment, no RxDB format. Download, ATTACH, import scoped rows.                               |
| Backend changes     | Sync pull queries (10 resolvers) + `sync_deletions` table + idempotent mutations                                                                    |
| Delete handling     | `sync_deletions` table + triggers. Existing queries untouched.                                                                                      |
| Maintenance risk    | `expo-sqlite` is a first-party Expo module. Guaranteed New Architecture support.                                                                    |
| Custom code         | Mutation queue (~800-1200 lines including error handling, retry logic, cache invalidation), sync pull client (~200 lines). Well-understood pattern. |

## Architecture

```
React Native App
  ├── On-demand board snapshots (CDN SQLite artifacts, per enabled board scope)
  ├── expo-sqlite manages the database
  ├── TanStack Query for reactive data + cache (staleTime: Infinity for local queries)
  ├── Mutation queue for offline writes
  └── Sync pull client for snapshot bootstrap + incremental updates
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

> **Superseded — kept for history.** This section describes an early design: ship one SQLite file with
> _every_ board's reference data bundled into the app binary (~150-200MB), so first launch has everything
> offline with no download at all. That design was not what shipped. The shipped design downloads a
> per-`(boardType, layoutId)` snapshot **only for boards the user actually enables**, fetched from a
> CDN-hosted artifact built by a nightly GitHub Action rather than committed to the app repo — see
> [`board-snapshots.md`](board-snapshots.md) for the real build pipeline, artifact format, client bootstrap
> flow, and rollout status. The rest of this section (app-size table, staleness discussion, build-pipeline
> pseudocode) reflects the superseded all-boards-in-binary approach, not the shipped one.

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

### Why an outbox, not dirty flags on the data tables

The obvious-seeming alternative — write only to the data tables and sync "unsynced" rows from them directly — was considered and doesn't survive contact with this design. Offline writes DO go to the data tables (optimistically, in the same SQLite transaction as the outbox insert, so the two can't diverge); the `pending_mutations` row is _replay state_ that a dirty-flag column cannot represent:

1. **Deletes.** An offline delete removes the data row — nothing remains to mark dirty. In-table tracking needs soft-delete/tombstone columns on every user table, which is exactly the WatermelonDB dealbreaker above.
2. **Pulls destroy in-table flags.** The pull client applies server rows with `INSERT OR REPLACE` (delete + re-insert), which would reset any client-only `dirty` column on every sync — and the manifest contract (resolver JSON keys == local columns) would need per-table carve-outs plus merge logic so pulls don't clobber unsynced edits.
3. **The server API is domain mutations, not row upserts.** The drainer replays ~18 distinct GraphQL mutations (`saveTick` vs `updateTick` vs `deleteTick`, `addFavorite`/`removeFavorite`, …). A dirty row can't say _which operation_ produced it; syncing row state directly means building a generic push protocol server-side — the rejected WatermelonDB/PowerSync shape.
4. **Retry/dead-letter bookkeeping** (`retry_count`, `last_error`, `status`, the dead-letter UI) lives on the outbox row instead of polluting every data table.
5. **Cross-table FIFO + cancellation.** The queue preserves user-action order across tables and lets an offline add→remove pair net out to zero server calls (the queued add is cancelled in-transaction).
6. **Queue-only entities.** `user_playlist_pins` has mutations but no local mirror table at all.

### How it works

1. User creates a tick offline → written to local SQLite immediately.
2. TanStack Query cache is invalidated (specific query keys per entity type) → UI updates instantly.
3. The mutation is added to a `pending_mutations` table in SQLite.
4. When online, the queue drainer processes mutations in order, calling GraphQL mutations.
5. Processed mutations are removed from the queue.
6. Failed mutations are retried up to `MAX_RETRY_COUNT` (10), then moved to dead letter state.

The drainer also exposes a renderer-neutral delivery notification after local
bookkeeping completes: `acknowledged` after the outbox row is deleted, or
`dead_letter` after a permanent failure. Tick-create notifications carry the
outbox idempotency key, which is the tick UUID. The mobile adapter fans these
events to `@boardsesh/board-react` so an offline first-send floor remains visible
until either a canonical climb-stat count reaches it or that exact tick's
post-ack primary repair succeeds, and is removed immediately on dead letter.
Repairs share the same 50-UUID batch coordinator as mount/reconnect catch-up;
an acknowledged token remains its own durable repair obligation if a delayed
repair is canceled during a board switch or its request fails. The next primary
read snapshots all exact acknowledged obligations immediately before dispatch,
and a successful response settles only that snapshot, never a later optimistic
tick on the same climb. Listener failures are isolated from the drain itself;
this seam does not change replay ordering or retry behavior.

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

### Native offline capability

Offline mode is permanently enabled in native builds. It no longer waits for or reacts to the former
`offline-board-downloads`, `offline-snapshot-bootstrap-v2`, `offline-download-progress`,
`offline-download-task-api`, or `offline-download-background-session` PostHog flags. Removing that
asynchronous decision eliminates the cold-launch race where a fresh board started the 500-row crawl before
the snapshot source appeared. `OfflineEngineFlagSync` publishes the baked native state to the module-level
store used by the GraphQL interceptor; the Expo web platform fork publishes false and never exposes native
snapshot I/O.

The nightly snapshot source is present whenever `EXPO_PUBLIC_SNAPSHOT_BASE_URL` was configured in the
mobile build. Without that URL the engine safely uses paged sync, but production builds are expected to
provide it. Byte progress and the task downloader are part of the native capability: iOS uses the background
DownloadTask session, while Android uses its task-specific foreground client.

The local SQLite database, queue draining, downloaded-board reads, pending-sync UI, and local-first online
reads all follow the same baked native decision. Reading data already on disk remains available whenever a
network request cannot be served, including captive-portal/dead-upstream failures. Manual sign-out remains
an unconditional data-safety boundary and still offers its existing confirmation and bounded queue drain.

**Sign-out and queued writes.** A manual sign-out best-effort drains the queue first (bounded at 3s so sign-out never hangs on a bad connection) after the confirm dialog. A **forced** sign-out — the auth interceptor's failed-refresh 401 or checkAuth's proactive-expiry path — deliberately skips both: the token is already dead, so the drain's requests could only fail, and there is no meaningful moment to show a dialog. Queued writes not yet flushed at that point are wiped with the rest of the local user data. This is the accepted trade-off for keeping the user-data wipe (a cross-account safety boundary on shared devices) unconditional.

**Two wipes, and which sign-out runs which** (issue #3621). `clearUserData` (`packages/mobile/src/db/connection.ts`) clears the user's own tables, the mutation queue and the user-scoped checkpoints, and deliberately keeps the downloaded board catalogs — that is what every sign-out the user did NOT choose runs: the forced 401, checkAuth's expiry, the web identity change, the confirmed-identity-changed branch. A token-refresh glitch must not cost someone a 271MB download. `purgeLocalDataForSignOut` is the **full** wipe an explicit sign-out runs (`signOut('manual')` behind the confirm, and `signOut('account_deleted')`): the same user tables **plus** `BOARD_DATA_TABLES`, then `deleteAllSyncMeta` — a whole-table `DELETE FROM sync_meta` rather than a prefix sweep, because the marker families sit across two prefix conventions and rows plus the markers describing them must die together (a surviving `scope-complete:` makes `isBoardDownloadedLocally` serve an empty catalog to local-first search as a whole board; a surviving checkpoint makes the strict `>` delta pull resume past rows that are gone) — then a `VACUUM` so the freed pages actually leave the file. It is one exclusive transaction inside AuthProvider's `setSigningOut(true)` window, so an in-flight pull page can't land after the delete. It reports `Offline Data Wiped On Sign Out` with the exact post-drain outbox depth it discarded, split into `pendingDiscarded` (writes the drain got a shot at) and `deadLettersDiscarded` (writes whose retries were already spent) — one `DELETE FROM pending_mutations` takes both, so reporting only the pending half told us zero for the loss this wipe is most likely to cause.

Both manual entry points (**More → Sign out** and the user drawer's **Log out**) go through `useConfirmSignOut` (`packages/mobile/src/hooks/use-confirm-sign-out.ts`), which always confirms and composes an honest message: the downloaded-boards sentence only when `board_climbs` actually holds rows (`hasDownloadedBoardData`, an O(1) `EXISTS`), plus two separate write counts from one `getOutboxSummary` read (the same gauge the drain gate and the outbox telemetry use, so the three can't disagree) — the pending one when writes are still waiting to send, and a dead-letter one when writes have already failed for good. They are separate sentences because the losses differ: a pending write still gets sign-out's drain, while a dead letter never will, so its sentence points at **Retry sync** instead. Counting only `status = 'pending'` used to tell a user whose whole outbox had dead-lettered — the writes the Sync-issues section was already offering a Retry button for — that there was nothing to lose, moments before deleting them. It probes the rows rather than the `syncEnabledBoards` toggle list or platform gate because the wipe is unconditional and the rows are what it deletes. The hook does **not** drain: `signOut` already runs its own bounded 3s drain, so the count shown is pre-drain and the copy promises an attempt to sync rather than a guaranteed discard. The confirm lives in the hook, not in `signOut`, so the forced paths can't inherit it.

### Per-board selective sync

User data (ticks, playlists, favorites, follows) syncs on native with no per-board opt-in. Board reference data syncs per-**scope**, where a scope is one `(boardType, layoutId, sizeId)` a user made available offline in **My Boards** (the offline toggle writes an encoded `"boardType:layoutId:sizeId"` key into `syncEnabledBoards`). Downloading always pulls **all sets** for that layout/size — a fixed superset that stays cacheable across users. `syncClimbs`/`syncClimbStats` take optional `layoutId`/`sizeId` args to scope the pull server-side (see the manifest); `sizeId` is ignored for moonboard. Checkpoints are keyed by `(tableName, scopeKey)` so each scope resumes from its own cursor. They survive a forced sign-out (the rows do too) so the next sign-in doesn't re-crawl; an explicit sign-out deletes both (see **Sign-out and queued writes** above).

**Turning the toggle off does not delete anything** — the rows and checkpoints are the expensive shared cache, so re-enabling resumes from the checkpoint instead of re-crawling. Reclaiming that disk space is a separate, explicit action: **More → Storage** (`StorageSettingsScreen`), which lists every scope that has rows (not just the enabled ones — a forced sign-out clears `syncEnabledBoards` while deliberately keeping the rows, and a kill-switch rollback leaves rows with the toggle unavailable, so "has rows, not enabled" is a real state, never an orphan to auto-reap). Removal goes through `removeOfflineBoard` (`packages/mobile/src/offline/remove-offline-board.ts`) → `removeBoardScopeData` (`@boardsesh/offline-sync`'s `sync/scope-teardown.ts`), which drops the scope's rows **and every `sync_meta` marker describing them in one exclusive transaction**: a surviving checkpoint would make the strict-`>` delta pull resume past the deleted rows and never revisit them, permanently gutting the catalog while `scope-complete:` still advertised it as whole. See that module's header for the full hazard list. A full `VACUUM` afterwards is what actually returns the pages to the filesystem (`db/vacuum.ts`).

**Local-first browse (live).** Climb **search + count + detail** are **local-first**: whenever the active board's exact scope is downloaded and the filters are on-device-expressible, they read local `board_climbs`/`board_climb_stats` (`search-climbs-local.ts` / `get-climb-local.ts`, mirroring the server's LEFT-JOIN standard search) **even while online** — a local query is far faster than a network round-trip. Freshness comes from the background sync (foreground + reconnect), which invalidates `['searchClimbs']`/`['climb']` after each pull so the next local read reflects new data; a downloaded board reads local regardless of connectivity, so connectivity isn't part of the query key. The **network** is used only when there's no usable local data: the board isn't downloaded, or the filter needs a table we don't sync. **Limitations:** filters needing un-synced tables — hold-state (STARTING/HAND/FOOT/FINISH), zone, tall/wide, beta-video — and the drafts path always go to the network (online) or are unavailable (offline); name search is ASCII-case-insensitive only; climb-detail satellites (comments, beta links, similar climbs, stats history) are network-only and absent offline. Trade-off: on a downloaded board, online reads reflect the last sync rather than the live server (acceptable for a climb catalog; the sync keeps it current).

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

    // One exclusive transaction per page; rows go in as multi-row
    // INSERT OR REPLACE ... VALUES (...),(...) statements chunked to
    // floor(999 / columnCount) rows so a statement never exceeds SQLite's
    // bind-variable limit (see upsertDocuments in pull-client.ts).
    await db.withExclusiveTransactionAsync(async (tx) => {
      for (const rows of chunk(documents, multiRowChunkSize(columns.length))) {
        const values = rows.flatMap((row) => columns.map((column) => toSqliteValue(row[column])));
        await tx.runAsync(buildMultiRowInsertSql(tableName, columns, rows.length), values);
      }
    });

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

Periodic cleanup: `DELETE FROM sync_deletions WHERE deleted_at < NOW() - INTERVAL '90 days'` (the daily
`pruneSyncDeletions` job).

Because that prune is a hard delete and the query above is a strict `>` keyset, a device that has been
away longer than the window can never be served the tombstones removed in the meantime. The client
guards it with a wall-clock **deletions-coverage marker** (`sync_meta['deletions-coverage']`, written
only when a deletions pull reaches its tail — never the checkpoint's own age, which stands still on a
device whose user simply deleted nothing). Once the marker is older than `90 - 10 = 80` days, `pullSync`
probes the network first and then rebuilds the local **user** tables from scratch: it deletes the rows of
every `USER_DATA_TABLES` entry plus their checkpoints and `checkpoint:deletions`, and the same cycle
re-pulls them from the epoch.

Downloaded board catalogs are deliberately left alone — no production path emits a board tombstone (the
only DELETEs of `board_climbs` / `board_climb_stats` run inside the transaction that sets
`boardsesh.suppress_sync_tombstones`), so clearing them would recover nothing and cost a full
re-download. `pending_mutations` is never touched either: unsynced local writes are not recoverable from
the server. Both numbers live in one place, `packages/shared/offline-sync/src/sync/retention.ts`, which
the backend prune job imports. See `sync/deletions-coverage.ts` for the invariant.

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

## Startup lock model

SQLite allows exactly one writer per database file. Everything below shares one
`boardsesh.db`, so who holds that write lock at launch — and for how long — decides
whether offline storage comes up at all.

**Who holds it**

| Writer                                                    | Connection                                                  | Lock window                                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup DDL (`ensureMutationQueueTable`, `runMigrations`) | the app's main connection                                   | milliseconds on a warm install; the full migration set on an upgrade                                                                           |
| Snapshot import (`bootstrapScopeFromSnapshot`)            | its own native connection (`withExclusiveTransactionAsync`) | one `BEGIN EXCLUSIVE` covering `reconcileScope` + `importScope` ONLY — the artifact is already downloaded to disk before the transaction opens |
| Paged crawl (`pull-client`)                               | its own native connection                                   | one short exclusive transaction per page, with a 5s `busy_timeout`, so a contender can win in the gaps                                         |
| `VACUUM` / teardown deletes                               | the main connection                                         | 5-20s on a 200-400MB file                                                                                                                      |

`OfflineBoardDownloadCompleted.durationMs` is **not** a lock-hold measurement. It is
stamped when the cycle first touches a scope and covers the manifest fetch and the
artifact download as well as the import — mostly network. Sizing a retry window off
it overstates the real contention by an order of magnitude. The measurement that
does describe the lock is `Offline SQLite Init Recovered`'s `elapsedMs`: how long a
launch that lost the lock took to win it back.

**Why the launch gate opens before the schema is ready**

`SQLiteProvider` renders nothing until its `onInit` promise resolves, so blocking
`initializeDatabase` until a retry wins would be a black screen for the length of the
chain. It therefore resolves after the FIRST attempt whatever that attempt did, and
the retries continue detached. A contended launch consequently renders the whole app
against a connection with no tables.

**The readiness contract**

- Non-React callers use `getDatabaseHandle()`, which stays `null` until migrations
  have run. They already null-check and fall back to the network.
- Callers that take the database from `useSQLiteContext()` bypass that gate — the
  provider hands out its connection regardless. Anything that **writes** through such
  a handle (the sync scheduler in `OfflineSyncBridge`, the download kick in
  `useBoardDownloads`) MUST gate on `useOfflineSchemaReady()` (`src/db/schema-ready.ts`).
- Read-only surfaces deliberately do NOT gate. They wrap their reads in a React Query
  `queryFn`, so a missing table lands in `isError` and renders the existing empty
  state; gating would strand them in a permanent spinner whenever init genuinely
  fails. They fold readiness into the `queryKey` instead, so a late flip refetches.
- Readiness can arrive late (a retry wins seconds in) and can go back to false
  (sign-out clears the handle), so it is a live store, not a one-shot flag. Anything
  that clears the database must do so through `setDatabaseHandle(null)` rather than
  poking the store, which is what keeps the two from disagreeing.

**Remounts**

`SQLiteProvider`'s effect teardown calls `db.closeAsync()`, so a remount mid-chain
closes the connection the chain captured and opens a new one. The retry chain is
single-flight for the process but retargets onto the latest connection on every
attempt; a failure against a superseded handle is a lifecycle artefact and is
deliberately not reported to error tracking.

## What stays the same

| Component             | Status                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `react-native-mmkv`   | KV preferences: active board, theme, onboarding, enabled boards list                                          |
| TanStack Query        | Data fetching + cache for both local SQLite and network-only data                                             |
| GraphQL subscriptions | Real-time party mode: queue sync, session events, wall confirm/disconnect                                     |
| `expo-secure-store`   | Auth tokens in iOS Keychain / Android Keystore                                                                |
| Backend GraphQL API   | Mostly unchanged. New sync pull queries + sync_deletions + idempotent mutations + addFavorite/removeFavorite. |
| Aurora sync daemon    | Unchanged. Picks up ticks without `aurora_id` and pushes to Aurora API.                                       |

## Board identity offline (why snapshots, not scope keys)

The board picker and My Boards get their list from `myBoards`, a network-only GraphQL
query. Offline the client's `networkMode: 'offlineFirst'` makes it PAUSE rather than
error, so both screens saw an empty list and told the user they had no boards (#3897).

The enabled-boards setting can't stand in for that list. A scope key is
`"boardType:layoutId:sizeId"` — it names a DOWNLOAD, not a board, and one download
serves every board the user has on that layout+size ("Marco's garage" and "Gym wall"
on the same Kilter Original 12x12 share one). It carries no `uuid`, `name`, `setIds`
or `angle`, and `uuid` is server-issued: `setActiveBoard`, `BoardProvider`, the BLE
wrapper and the board-presence subscription all key on it, so it can never be
synthesised from board-config.

So board identity is snapshotted at download time into one more MMKV settings key
(`offlineBoardsV1`, see `packages/mobile/src/settings/offline-boards.ts`) as a flat
list of `UserBoard`s deduped by `uuid` — never a scope-keyed map, which would hide one
of two boards sharing a scope. Reads run through a runtime shape guard so a card
written by an older build degrades (one fewer row) instead of crashing the picker, and
the list is cleared at sign-out because it carries the previous account's board names.

The picker offers a snapshot only when its scope is in `getDownloadedScopeKeys()` —
the honest "will actually serve climbs" signal — plus the active board unconditionally.

Card lifecycle, since no single event covers it:

- **Written** by `enableBoardsOffline` (the one download funnel) and refreshed from a
  live `myBoards` by `useRememberDownloadedBoards`, which remembers boards whose scope
  is in `syncEnabledBoards`. Deliberately not "or already downloaded": toggling
  "Available offline" off leaves the rows and checkpoint on disk so re-enabling
  resumes instantly, so a downloaded-keyed refresh would re-write the card the toggle
  just dropped.
- **Dropped per scope** (`forgetOfflineBoardScope`) when offline is turned off or the
  data is removed — the download is per scope, so every board sharing it loses its card.
- **Dropped per board** (`forgetOfflineBoard`) on delete and unfollow, and pruned
  against a **complete** `myBoards` (`hasMore === false`) for the deleted-on-another-
  device case. A card the backend no longer knows is worse than a stale row: activating
  it writes a dead `uuid` into `active-board-store` and board presence. `myBoards` pages
  at 20, which is why the prune refuses to run on a truncated page.

## Account lifecycle

On logout or account switch:

1. Cancel any in-progress sync pull or mutation queue drain.
2. Delete user data tables from SQLite (`boardsesh_ticks`, `playlists`, `playlist_climbs`, `user_favorites`, `user_follows`, `setter_follows`, `playlist_follows`, `user_playlist_pins`, `pending_mutations`). Board reference data stays — no need to re-copy the 150-200MB pre-warmed database.
3. Clear the TanStack Query cache.
4. Reset `syncEnabledBoards` and the `offlineBoardsV1` snapshots (board names must not survive into the next account on a shared device).
5. On new login, sync pull client fetches the new user's data (small, seconds).

## Usage telemetry

Offline mode's whole value proposition is "you can still climb when the signal
can't". Until issue #4317 nothing in the telemetry could tell an offline-served
read apart from an online one, so that claim was unfalsifiable. This section is
the source of truth for the signals that fix it. They are mobile-only today (the
engine is shared, so a future web offline consumer would emit the same things).

### The `connectivity` super property

`packages/mobile/src/lib/analytics-connectivity.ts` registers a PostHog super
property `connectivity: 'online' | 'offline'` at analytics startup and again on
every real network transition. PostHog stamps super properties onto events at
**capture** time, so every event the app sends — `$screen`, `Tick Logged`, the
offline download events — becomes segmentable by connectivity, retroactively and
for free.

Three things are worth knowing before trusting a number derived from it:

- **Offline-captured events do arrive.** The RN SDK persists its queue to disk
  (`persistence: 'file'` is the default), and `@posthog/core`'s flush only
  dequeues a batch when the failure was **not** a `PostHogFetchNetworkError` — a
  network failure leaves the batch in the queue. So events captured in airplane
  mode survive an app kill and flush on reconnect, still carrying the
  `connectivity: 'offline'` they were captured with. The queue is capped at 1000
  events with the oldest dropped, which is the reason the read signal below is a
  rollup rather than one event per read.
- **It is best-known connectivity, not ground truth.** It mirrors React Query's
  `onlineManager`, which the app seeds from NetInfo asynchronously and which
  defaults to online (`query-provider.tsx`), and which tracks `isConnected`, not
  `isInternetReachable`. A genuinely-offline cold start can stamp its first
  events `online`, and a captive portal or a dead gym-wifi upstream reads
  `online` throughout. Both errors under-count offline usage, so any number built
  on this is a floor.
- **It is re-registered after `analytics.reset()`.** PostHog's reset clears every
  super property and the client singleton is cached, so a sign-out would
  otherwise drop `connectivity` for the rest of the launch — the same trap
  `environment` and `$raw_user_agent` already document in `posthog-client.ts`.

### The offline-read signal

`connectivity` says whether the network was usable. It cannot say whether the
local database actually answered anything — "offline and browsing my downloaded
Kilter catalog" and "offline staring at an empty screen" look identical through
it, and that distinction _is_ the value proposition. So the interceptor emits a
second, narrower signal.

Every offline-served read funnels through `offlineAwareRequest()` in
`packages/mobile/src/lib/graphql/offline-request.ts`, which already knows which
lane it took. Four terminal outcomes are worth measuring:

| Outcome                                    | Event                      | Lane / reason          |
| ------------------------------------------ | -------------------------- | ---------------------- |
| Offline, board downloaded, row found       | `Offline Read Served`      | `offline_local`        |
| Network threw, board downloaded, row found | `Offline Read Served`      | `network_error_local`  |
| Online, flag on, board downloaded          | `Offline Read Served`      | `online_local`         |
| Offline, board not downloaded              | `Offline Read Unavailable` | `board_not_downloaded` |
| Offline, board downloaded, filter gap      | `Offline Read Unavailable` | `filter_unsupported`   |
| Offline, no database handle                | `Offline Read Unavailable` | `local_db_unavailable` |

`network_error_local` is real offline value that `onlineManager` mislabels as
online (captive portal, dead gym-wifi upstream, cold-start seed race), so it
counts toward the north-star. `online_local` is the flag-on latency
optimization — it proves the local path is exercised but it is **not** offline
usage, and it is excluded from the north-star. Expect it to dominate the
breakdown once #4312 bakes the engine flag on.

Two labelling rules keep those buckets honest, and both are cases where the
obvious code books the wrong thing:

- **A local miss is never a served read.** Climb detail and the single-grade read
  treat a null row as a miss (`isLocalMiss`) and retry over the network while
  online. Offline there is no retry, so the null is returned as-is — and the
  caller gets exactly the nothing the empty fallback would have given, so it
  counts in no served lane. It gets no `Offline Read Unavailable` either: for the
  grade reads a null row is indistinguishable from a genuinely ungraded climb
  (MoonBoard, too few ascents), so counting it would put a number we can't verify
  on the gap tile.
- **A missing download outranks the filter gap.** An unsupported filter run
  against a board that was never downloaded is reported as
  `board_not_downloaded`. Teaching SQLite every filter (#4002) would still serve
  that read nothing; only a download (#4318) would.

**These events are rolled up, not per-read.** Search and its count fire on every
keystroke, so a per-read event would be thousands per session — and PostHog's
offline queue holds 1000 events and drops the _oldest_ when full, so a chatty
read event captured offline would evict the ticks and screens sharing that
queue. `createOfflineUsageSignal` (`@boardsesh/offline-sync`, pure TS with `emit`
and `now` injected) counts reads per `(UTC epoch-day, lane, board)` and emits
only when the count crosses a rung of `[1, 10, 100]`:

- A suppressed read costs one integer compare, one `Map` lookup and one
  increment. No I/O, no persistence, no battery.
- Worst case for a pathological user is 3 lanes x 2 boards x 3 rungs = 18
  events/day; typical is one or two. A `maxEmitsPerDay` backstop (60) stops any
  future call site turning it into a firehose. Per day, not per process: a phone
  can keep the process resident for weeks, and a lifetime cap would eventually
  mute the north-star for the heaviest offline users.
- Rung 1 fires on the _first_ qualifying read, so the north-star can never be
  lost to an app kill. The deeper rungs only add depth.
- `readCount` is therefore the **rung**, never a raw counter, and the absence of
  a follow-up event means "fewer than the next rung", not "no more reads".
- `surface` (`search` / `climb_detail` / `grade`) is a descriptive prop of the
  read that crossed the rung, **not** part of the key — keying on it would
  roughly triple the volume for a breakdown nobody has asked for yet.
- The counter is in-memory and not persisted. A relaunch re-arms the day, which
  can double-count a user; harmless for a unique-users metric. It is **not**
  harmless across an account switch, so `resetOfflineUsageSignal()` runs on both
  sign-out paths in `auth-provider.tsx` — without it the next user's first
  offline day silently never fires.

### North-star

> **Weekly unique users who fire `Offline Read Served` with
> `lane in ('offline_local', 'network_error_local')`.**

Supporting tiles, in the order they answer questions about it:

1. **Depth** — weekly unique users who crossed the 10-read rung (`readCount > 9`),
   same lane filter. Distinguishes "opened the app once with no signal" from
   "climbed a whole session off the local database". A rung count, not a median
   of per-user maxima: `readCount` only ever takes the ladder values, so a median
   over it would read as precision the rollup does not have.
2. **The gap** — weekly unique users on `Offline Read Unavailable`, broken down
   by `reason`. `board_not_downloaded` is the audience #4318's nudges exist to
   convert; `filter_unsupported` is #4002's. `local_db_unavailable` is neither —
   it means the database handle was missing (init retrying or wedged, #4313 /
   #4314), so those users may already have the board downloaded.
3. **Conversion** — `Offline Board Download Completed` → `Offline Read Served`
   (offline lanes) over 30 days: of the people who downloaded a board, how many
   ever used it away from signal.
4. **Any activity offline** — weekly unique users on any event with
   `connectivity == 'offline'`. The loosest possible read of "did anyone use the
   app with no network", and the sanity check on the three above.

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

- ~~Pre-warmed SQLite database build pipeline (GitHub Action).~~ Shipped as the per-board nightly snapshot
  export instead — see [`board-snapshots.md`](board-snapshots.md).
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

## Discovery nudges (issue #4318)

4.4% of monthly actives had downloaded a board when the epic was opened, and 82%
of those stopped at one. The engine was not the problem — nothing in the app ever
_suggested_ a download. Before this, offline was reachable from exactly two
places: the per-row toggle on My Boards and a switch buried in More.

### Four surfaces, two kinds

The split matters more than the count.

**Prompts interrupt.** The user asked for something else and the app spoke
anyway, so they carry the full frequency machinery: a per-surface cooldown, a
lifetime cap, a cross-surface cooldown so two prompts can't stack, and a quiet
period after any acceptance.

| Surface        | Where                           | Caps                                                       |
| -------------- | ------------------------------- | ---------------------------------------------------------- |
| `post_session` | `app/(tabs)/record/summary.tsx` | 14d cooldown, max 3 lifetime, 72h global, 30d after accept |

**Affordances don't.** They live inside a screen the user chose to open, usually
in place of a dead end. Capping them would mean the empty state this set out to
fix reverts to a dead end — possibly the day after an unrelated prompt. They are
bounded by eligibility and dismiss-forever only.

| Surface      | Where                                                         |
| ------------ | ------------------------------------------------------------- |
| `no_catalog` | boards-picker `isLocalOnly` empty state + a new climbs branch |
| `board_card` | download glyph on the Your Boards carousel                    |
| `whats_new`  | curated card pinned above the generated changelog timeline    |

### Arming is not downloading

`useBoardDownloads` exposes two actions, and the difference is a bug fix, not a
convenience:

- `enableBoardsOffline` — enable + `triggerSync`. Only from surfaces that are
  genuinely online.
- `armBoardsOffline` — enable, **no cycle**. From every surface that can fire
  offline.

`onlineManager.isOnline()` is TRUE on captive-portal wifi, so `triggerSync`'s own
guard does not short-circuit there: the cycle runs, every request fails, and
`recordRetryableBootstrapFailure` spends one of the two `MAX_BOOTSTRAP_ATTEMPTS`.
Two taps of an offline CTA and that scope is pinned to the multi-minute paged
crawl (#4313). Nothing is lost by waiting — the scheduler's `subscribeConnectivity`
trigger runs a cycle the moment the device reconnects, reading the latest
`syncEnabledBoards`.

The user-visible consequence: an accepted offline nudge is a promise, not a
download. The copy and the toast say so, and `Offline Nudge Accepted` carries
`armedOnly: true` — without it the funnel reads as accepts that never downloaded.

### Eligibility

`shouldShowNudge` (pure, `src/lib/offline-nudges/nudge-policy.ts`) gates on
`boardDownloadState() !== 'off'`, i.e. on `syncEnabledBoards` — **not** on
"absent from `downloadedScopeKeys`". An offline arm leaves the scope `'pending'`,
which satisfies the naive gate, so the nudge would re-prompt for the board it
just armed. `autoOfflineBoards` suppresses everything (that user downloads
everything already), and screenshot mode suppresses everything so App Store
captures never sprout nudge cards.

### Events

`Offline Nudge Shown / Accepted / Dismissed`, split by `surface`, with
`{ boardType, layoutId, scopeKey, downloadedBoardCount }` plus `armedOnly` on
accept and `dismissKind` on dismiss. State lives in one AsyncStorage key,
`offlineNudgeStateV1`.

`board_card` is the exception: the glyph emits `Accepted` only. A card scrolling
past in a carousel is not a suggestion the way a prompt is, so there is no
impression event to divide by — read that surface as accepts joined to
`Offline Board Download Completed`, not as a conversion rate.

### Flag ramp

Retired. The nudges shipped behind `offline-discovery-nudges`; the flag and its
`useOfflineNudgesEnabled` gate were deleted rather than left parked at 0%. Every
surface now carries only the platform check `useOfflineDownloadsEnabled` — the
same gate `board_card` always had on its own, native offline availability.

Keep watching `Offline Nudge Accepted` against the completed / failed split per
board type: nudging someone into a download that takes minutes is a worse first
impression than not nudging at all.

### Hand-off to #3621 (sign-out wipe)

`offlineNudgeStateV1` must be added to the logout wipe. A stale key across
accounts on a shared device silently suppresses every nudge for the next user.
`__resetNudgeStateCacheForTests` in `nudge-storage.ts` is the in-memory half.
