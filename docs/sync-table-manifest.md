# Sync Table Manifest — the cross-package contract

This is the **single source of truth** binding four implementations together:

1. **Backend** sync-pull resolvers (`packages/backend`) — emit JSON documents whose keys
   are listed here, and deletion triggers that emit `record_id` strings encoded as listed here.
2. **Client SQLite DDL** (`packages/shared/offline-sync/src/db/schema.ts`) — column names + types + PKs match exactly.
3. **Client `table-config.ts`** (`packages/shared/offline-sync/src/sync/table-config.ts`) `primaryKeyColumns` — match the
   **Local PK** column order here.
4. **Board-snapshot export artifacts** (`packages/backend/src/scripts/export-board-snapshots.ts`) — the
   `board_climbs`/`board_climb_stats` columns baked into the nightly SQLite artifacts (see
   [`board-snapshots.md`](board-snapshots.md)). This one needs no manual upkeep: the export's DDL is derived
   from the shared client `MIGRATIONS`, and its SELECT column lists come from each table's `localColumns` in
   `table-config.ts` — the same source this manifest's **Local PK**/**Columns** entries below describe. A
   `localColumns` change here flows into the next artifact automatically. The one thing that does NOT
   auto-verify is row _shaping_ — that the export's Postgres → SQLite coercion actually matches the live
   resolver → client-upsert coercion byte-for-byte. That's enforced by
   `packages/backend/src/__tests__/snapshot-export-golden.test.ts`, which runs both paths against the same
   seeded rows and diffs the result; treat it as this manifest's enforcement for the snapshot artifact the
   same way this doc is the source of truth for the other three.

It exists because `pull-client.ts:upsertDocuments` does `INSERT OR REPLACE INTO <table> (<Object.keys(doc)>)`:
the resolver's JSON keys **are** the local column names. And `processDeletions` splits `record_id` on `:`
into `primaryKeyColumns`-many parts. So resolver output, local DDL, and table-config PKs must agree to the character.

One kind of field escapes that equivalence. `TableSyncConfig.transientColumns` lists keys a resolver emits on
purpose and the table deliberately does not store: the pull client skips them like any other unknown column, but
**without** reporting schema drift, and the committed page is handed to `onDocumentsPulled` first so the platform
can use the value before it is dropped. Exactly one exists today — `spray_walls.photo_url`, the presigned photo
URL described in that table's section below. Anything else a resolver emits that is not in a table's **Columns**
list is drift, and is reported as such.

## Casing & types

Schema changes must cover already-downloaded rows as well as DDL: when adding a reference-data field,
bump the table's `refreshRevision` and add the field to its cumulative `refreshColumns` list in
`table-config.ts` so old checkpoints cannot skip its backfill or certify an incomplete response.
See [snapshot compatibility and catalog refresh](board-snapshots.md#refreshing-fields-skipped-by-older-apps).
There is one documented exception — `board_climbs.missing_hold_count`, whose reasoning is in that table's section
below and turns on the new field being NULL for every row that was already downloaded.
The client tolerates additive columns from newer producers; tests enforce exact column/PK parity for the
current migration, configuration, resolver, and export contracts.

- **All JSON keys and SQLite columns are `snake_case`** (identical to Postgres column names). Resolvers must
  emit snake_case (raw SQL select or explicit mapping) — NOT drizzle's camelCase JS fields.
- SQLite types: `TEXT`, `INTEGER`, `REAL`. Booleans → `INTEGER` 0/1 (the upsert maps JS booleans). Timestamps → `TEXT`
  ISO-8601. Postgres arrays (`int[]`) → `TEXT` holding a JSON array (the upsert maps JS objects via `JSON.stringify`).
- GraphQL timestamps are `String!` (ISO-8601), **not** a `DateTime` scalar — the codebase has no `DateTime` scalar
  and every existing timestamp field is `String!`. Do not introduce one.

## Single-user local DB

The on-device SQLite holds **exactly one user's** data (wiped on logout — see account lifecycle in
`offline-sync-plan.md`). Therefore **local PKs omit the user-scoping column** (`user_id` / `follower_id`).
This is deliberate and load-bearing:

- It lets an **offline write** (which may not have the server's bigserial `id` or even the user id handy) dedupe
  against the later **synced row** via the natural key, using `INSERT OR REPLACE`.
- It dictates the **deletion `record_id` encoding** — the trigger must emit the _same_ natural key, NOT the
  server `id`. This **overrides** the illustrative `OLD.id::text` encodings in `offline-sync-plan.md` §"Per-table
  trigger functions". Where this manifest and that doc disagree on `record_id`, **this manifest wins**.

The server `id` bigserial is still synced as a plain (non-PK) column where it's useful, but never as the local PK.

## GraphQL shapes (add to shared-schema SDL)

```graphql
scalar JSON # already exists
input SyncCursorInput {
  updatedAt: String
  syncSeq: String
}
type SyncCursor {
  updatedAt: String!
  syncSeq: String!
}
type SyncResult {
  documents: [JSON!]!
  cursor: SyncCursor!
  hasMore: Boolean!
}

type SyncDeletion {
  tableName: String!
  recordId: String!
  deletedAt: String!
}
type SyncDeletionsResult {
  deletions: [SyncDeletion!]!
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
  syncClimbs(boardType: String!, layoutId: Int, sizeId: Int, cursor: SyncCursorInput, limit: Int! = 500): SyncResult!
  syncClimbStats(
    boardType: String!
    layoutId: Int
    sizeId: Int
    cursor: SyncCursorInput
    limit: Int! = 500
  ): SyncResult!
  syncClimbGrades(
    boardType: String!
    layoutId: Int
    sizeId: Int
    cursor: SyncCursorInput
    limit: Int! = 500
  ): SyncResult!
  syncSprayWalls(
    boardType: String!
    layoutId: Int
    sizeId: Int
    cursor: SyncCursorInput
    limit: Int! = 500
  ): SyncResult!
  syncDeletions(cursor: SyncCursorInput, limit: Int! = 500): SyncDeletionsResult!
}

input AddFavoriteInput {
  boardName: String!
  climbUuid: String!
  angle: Int!
}
input RemoveFavoriteInput {
  boardName: String!
  climbUuid: String!
  angle: Int!
}

type Mutation {
  addFavorite(input: AddFavoriteInput!): Boolean!
  removeFavorite(input: RemoveFavoriteInput!): Boolean!
  # plus: add `uuid: ID` (optional) to SaveTickInput and CreatePlaylistInput
}
```

### Composite cursor (every sync resolver)

```sql
WHERE <user/board scope>
  AND (updated_at, <seq>) > ($since_ts, $since_seq)
ORDER BY updated_at ASC, <seq> ASC
LIMIT $limit
```

`<seq>` is `id` (bigserial) for user tables, `sync_seq` (new bigserial) for
`board_climbs`/`board_climb_stats`/`board_climb_grades`. `board_climb_grades` uses `computed_at`
(not `updated_at`) as the cursor timestamp.
Returned `cursor.syncSeq` is that value **stringified**. First call: `cursor` is null → start from
`('1970-01-01T00:00:00.000Z', 0)` (a value the cursor validator accepts back — `'epoch'` would be rejected on replay).
`hasMore = (rows.length === limit)`. The cursor `updatedAt` is the last row's `updated_at` ISO string.

Every page additionally excludes rows younger than the **stability window**
(`updated_at < now() - 30s`, `SYNC_STABILITY_WINDOW_SECONDS`, tests set it to 0): `updated_at` is stamped at
transaction start, so a long write transaction can commit a row _behind_ an already-advanced cursor — skips are
permanent, a deferred row is just picked up next pull. Client-side, the pull applies **deletions first, then table
upserts**, and a tombstone only deletes local rows with `updated_at <= deletedAt` (resurrection guard) — together
these make server-side delete-then-recreate converge. Bulk board re-imports suppress the deletion triggers entirely
via `SET LOCAL boardsesh.suppress_sync_tombstones = 'on'` (see `clearBoardData`).

## Idempotency contract

- `saveTick(input)` and `createPlaylist(input)` gain **optional `uuid: ID`**. When the client supplies it:
  `INSERT ... ON CONFLICT (uuid) DO NOTHING`; if no row returned, `SELECT` the existing row by `uuid` and return it.
  (Preserves the original on replay.) When absent (existing web callers): generate `uuidv4()` as today. `uuid` is
  already a UNIQUE column on both `boardsesh_ticks` and `playlists`.
- `addFavorite`: `INSERT INTO user_favorites (...) ON CONFLICT (user_id, board_name, climb_uuid, angle) DO NOTHING`.
- `removeFavorite`: `DELETE FROM user_favorites WHERE user_id=$u AND board_name=$b AND climb_uuid=$c AND angle=$a`
  (deleting a nonexistent row is a no-op — idempotent). Both return `Boolean!` (`true`). Reuse `ToggleFavoriteInputSchema`'s
  field validation for the Zod schemas.

## Phase 2 migrations (drizzle, next index 0108)

- **`updated_at TIMESTAMP NOT NULL DEFAULT NOW()` + `BEFORE UPDATE` trigger** on the 8 tables lacking it:
  `user_favorites`, `user_follows`, `setter_follows`, `playlist_follows`, `user_playlist_pins`, `playlist_climbs`,
  `board_climbs`, `board_climb_stats`. (`boardsesh_ticks` and `playlists` already have it.) Backfill from
  `created_at`/`added_at`/`NOW()`. One shared `set_updated_at()` function, one trigger per table. **Caveat:**
  `board_climbs.created_at` is a `text` column (Aurora string) — backfill `updated_at` with `NOW()`, do not parse it.
- **`sync_seq BIGSERIAL`** on `board_climbs` and `board_climb_stats` (they have no bigserial id), indexed
  `(updated_at, sync_seq)`.
- **`sync_deletions`** table + per-table `AFTER DELETE` triggers, `record_id` encoded per the table below.
  Index `(user_id, deleted_at, id)`. Use the `0053_add_vote_counts.sql` trigger/function file as the precedent.
- Generate with `vp exec drizzle-kit generate --custom` from `packages/db/` (after `vp run build:db`) for the
  trigger/function SQL; paste SQL into the minted file (mirrors 0053/0091/0100). Never reference a table the
  migration point doesn't have.
- **Test DB:** integration tests do NOT run migrations — mirror any new column/table/trigger you want exercised
  into `packages/backend/src/__tests__/schema-sql.ts` by hand, and add new tables to `TABLES_TO_RESET` in `setup.ts`.

---

## Per-table specification

Legend — **Scope**: how the resolver filters rows. **Seq**: cursor 2nd component. **Del**: deletion `record_id` encoding
(segment count must equal Local PK length). **Hook**: is there an offline write hook today.

**Encoding invariant — no PK component may contain a `:`.** Composite deletion `record_id`s are colon-joined by the
triggers and colon-split by the client (`processDeletions`); a colon inside any component shifts the segment count and
the client skips the deletion (safe, but the tombstone is lost). This holds today because every composite-PK component
is a board type (enum), a UUID, an angle integer, a username, or a playlist uuid — none can contain `:`. Any NEW
composite-keyed sync table must keep this true (or version the encoding).

### `boardsesh_ticks` — `syncTicks` (user data)

- Scope: `user_id = $userId`. Seq: `id`. updated_at: **exists**. Hook: **yes** (`saveTick`).
- Local PK: **`uuid`** (client-generated = idempotency key). table-config: `['uuid']` ✓ (already correct).
- Del: trigger emits `record_id = OLD.uuid` (1 segment).
- Columns (snake*case): `uuid` (PK), `user_id`, `board_type`, `climb_uuid`, `angle`, `is_mirror`, `status`,
  `attempt_count`, `quality`, `difficulty`, `is_benchmark`, `comment`, `climbed_at`, `session_id`, `created_at`, `updated_at`.
  (Skip aurora*\_/kilter\_\_ bookkeeping, `board_id`, `inferred_session_id`.) Index `(climb_uuid, board_type, angle)` for logbook reads.

### `playlists` — `syncPlaylists` (user data)

- Scope: join `playlist_ownership po ON po.playlist_id = playlists.id AND po.user_id = $userId AND po.role='owner'`.
  Seq: `playlists.id`. updated_at: **exists**. Hook: no.
- Local PK: **`uuid`**. table-config: `['uuid']` ✓.
- Del: `record_id = OLD.uuid` (1 seg).
- Columns: `uuid` (PK), `board_type`, `layout_id`, `name`, `description`, `is_public`, `color`, `icon`,
  `created_at`, `updated_at`, `last_accessed_at`.

### `playlist_climbs` — `syncPlaylistClimbs` (user data)

- Scope: rows whose playlist is owned by `$userId` (join playlist_ownership). Seq: `playlist_climbs.id`.
  updated_at: **added by Phase 2**. Hook: no.
- Local PK: **`(playlist_uuid, climb_uuid)`**. table-config: `['playlist_uuid','climb_uuid']` ✓.
- Resolver must **emit `playlist_uuid`** (join `playlists` on `playlist_id`), NOT the bigint `playlist_id`.
- Del: trigger emits `record_id = <playlist_uuid>:<climb_uuid>` (2 segs) — trigger looks up `playlists.uuid` from
  `OLD.playlist_id`. (Overrides the doc's `OLD.id::text`.)
- Columns: `playlist_uuid`, `climb_uuid`, `angle`, `position`, `added_at`, `updated_at`.

### `user_favorites` — `syncFavorites` (user data)

- Scope: `user_id = $userId`. Seq: `id`. updated_at: **added by Phase 2**. Hook: **yes** (`addFavorite`/`removeFavorite`).
- Local PK: **`(board_name, climb_uuid, angle)`** — note the column is **`board_name`**, not `board_type`.
  table-config: change `['user_id','climb_uuid','angle']` → **`['board_name','climb_uuid','angle']`** (B8).
- Del: trigger emits `record_id = <board_name>:<climb_uuid>:<angle>` (3 segs). **Overrides** the doc's `OLD.id::text`.
- Columns: `board_name`, `climb_uuid`, `angle`, `user_id`, `created_at`, `updated_at`.
- Offline hook: insert `(board_name, climb_uuid, angle, created_at, updated_at)` — **remove the synthetic `id` column**
  (B8). `user_id` may be NULL offline (filled on next sync).

### `user_follows` — `syncUserFollows` (user data)

- Scope: `follower_id = $userId`. Seq: `id`. updated_at: **added by Phase 2**. Hook: **yes** (`followUser`/`unfollowUser`).
- Local PK: **`(following_id)`**. table-config: change `['follower_id','followed_id']` → **`['following_id']`** (B8 —
  the column is `following_id`, and follower is always the local user).
- Del: `record_id = OLD.following_id` (1 seg).
- Columns: `following_id`, `follower_id`, `created_at`, `updated_at`.
- Offline hook: insert `(following_id, created_at, updated_at)` — remove synthetic `id`; DELETE `WHERE following_id = ?`.

### `setter_follows` — `syncSetterFollows` (user data)

- Scope: `follower_id = $userId`. Seq: `id`. updated_at: **added by Phase 2**. Hook: no.
- Local PK: **`(setter_username)`**. table-config: change `['user_id','setter_username']` → **`['setter_username']`**.
- Del: `record_id = OLD.setter_username` (1 seg — single segment, so no `:`-split ambiguity even if a name contained `:`).
- Columns: `setter_username`, `follower_id`, `created_at`, `updated_at`.

### `playlist_follows` — `syncPlaylistFollows` (user data)

- Scope: `follower_id = $userId`. Seq: `id`. updated_at: **added by Phase 2**. Hook: no.
- Local PK: **`(playlist_uuid)`**. table-config: change `['user_id','playlist_uuid']` → **`['playlist_uuid']`**.
- Del: `record_id = OLD.playlist_uuid` (1 seg).
- Columns: `playlist_uuid`, `follower_id`, `created_at`, `updated_at`.

### `board_climbs` — `syncClimbs(boardType, layoutId?, sizeId?)` (board data, per-board)

- Scope: `board_type = $boardType` [`AND layout_id = $layoutId` `AND compatible_size_ids @> ARRAY[$sizeId]` when given;
  `sizeId` ignored for moonboard]. Seq: **`sync_seq`**. Hook: no.
- Local PK: **`uuid`**. table-config: `['uuid']` ✓.
- Del: trigger emits `record_id = OLD.uuid` (1 seg), `user_id = NULL` (reference data).
- Columns: `uuid` (PK), `board_type`, `layout_id`, `setter_id`, `setter_username`, `name`, `description`, `hsm`,
  `edge_left`, `edge_right`, `edge_bottom`, `edge_top`, `angle`, `frames_count`, `frames_pace`, `frames`,
  `is_draft`, `is_listed`, `is_hidden` (schema v5, community-hidden flag), `created_at`, `published_at`, `user_id`, `required_set_ids` (JSON text),
  `compatible_size_ids` (JSON text), `characteristics` (JSON text, schema v2), `hold_fingerprint`,
  `missing_hold_count` (schema v7), `updated_at`, `sync_seq`.
- `missing_hold_count` is a nullable INTEGER — how many of a climb's holds have since come off the wall — and is
  spray-only in practice: it is NULL for every climb on the catalogue boards, because holds do not come off a
  Kilter. It is what lets `search-climbs-local.ts` answer the Intact / Lost-holds filter (SW-12) offline instead
  of declining it.
- It was added **without** bumping `refreshRevision`, the exception noted in "Casing & types". A bump means every
  already-downloaded scope must re-crawl to backfill the field, which is every enabled Kilter and Tension
  catalogue — tens of thousands of rows each — replayed to fill in a column that is NULL on all of them. Spray
  scopes are new in this release, so no checkpoint predating the column can exist for one, and the reader's
  predicate is NULL-safe (`COALESCE(missing_hold_count, 0)`, the same "unknown reads as intact" rule the server's
  `holdIntegrityCondition` applies), so a row pulled before v7 reads as intact rather than as wrong. Both
  conditions a bump exists to protect are therefore already met.
- LIVE: `syncEnabledBoards` holds `"boardType:layoutId:sizeId"` scope keys (My Boards → offline toggle), so a
  download is a fixed (type, layout, size) superset — all sets — that stays cacheable across users. Climb
  **search + detail** are **local-first**: whenever a scope is downloaded they read these tables
  (`search-climbs-local.ts` / `get-climb-local.ts`) even while online, for speed, with the background sync keeping
  them fresh. Default `syncEnabledBoards` is `[]` so nothing downloads until a board is enabled.

### `board_climb_stats` — `syncClimbStats(boardType, layoutId?, sizeId?)` (board data, per-board)

- Scope: `board_type = $boardType` [`AND EXISTS (board_climbs bc WHERE bc.uuid = climb_uuid AND bc.layout_id = $layoutId
AND bc.compatible_size_ids @> ARRAY[$sizeId])` when scoped — the stats table has no `layout_id`, so it correlates
  back to `board_climbs`, with fully-qualified cursor columns]. Seq: **`sync_seq`**. Hook: no.
- Local PK: **`(board_type, climb_uuid, angle)`** (B9). table-config: change `['climb_uuid','angle']` →
  **`['board_type','climb_uuid','angle']`**.
- Del: trigger emits `record_id = OLD.board_type:OLD.climb_uuid:OLD.angle` (3 segs) — matches the doc. `user_id = NULL`.
- Columns: `board_type`, `climb_uuid`, `angle`, `display_difficulty`, `benchmark_difficulty`, `ascensionist_count`,
  `difficulty_average`, `quality_average`, `fa_username`, `fa_at`, `updated_at`, `sync_seq`.
- Server-only (NOT pulled to devices): the provenance columns `upstream_synced_at` and `tick_graded_at` (#4798),
  the upstream/Boardsesh count and quality-blend splits. Devices read the materialized results
  (`ascensionist_count`, `quality_average`, `display_difficulty`); provenance only ever decides which server-side
  writer may touch a column, so shipping it would grow every stats row for nothing.
- **Second local writer (#5227):** the layout-wide `climbStatsUpdated` stream, via `writeClimbStatsEvents`
  (`@boardsesh/offline-sync`). Each event first takes an autocommit pre-read that LEFT JOINs the local row;
  an equal-or-older revision settles there as `stale` and never opens a write connection at all (the
  publisher republishes on every debounced pass while `sync_seq` only bumps on a client-visible change, so
  that is the common case). Whatever is left goes through ONE exclusive transaction per drain pass on its own
  connection — one statement per event, requiring the climb in `board_climbs` and gated on
  `excluded.sync_seq > COALESCE(sync_seq, -1)`. A lost lock is not a dropped event: the batch is requeued and
  the drain stands down for a second, then retries. The same writer also takes the rows of the periodic
  reconciliation read (`climbStatsForClimbs`), because Redis PUBLISH is fail-open and a missed publish is
  otherwise undetectable. It writes `display_difficulty`, `ascensionist_count`, `difficulty_average`,
  `quality_average` and `sync_seq`, and never `benchmark_difficulty`, `fa_username` or `fa_at` (the recompute
  produces no benchmark, and the event's `fa_at` is raw Postgres text where the pull stores ISO). `updated_at`
  is stamped with the epoch watermark on INSERT and left alone on UPDATE: it is the pull cursor, so a row
  stamped "now" could never be deleted again by a tombstone or by snapshot reconcile. The next pull fills in
  every column the stream skipped.
- **Because of that second writer, the pull's own upsert on this table is revision-guarded** — the only table
  where it is. `TABLE_CONFIGS.board_climb_stats.revisionColumn = 'sync_seq'` turns the page insert into
  `INSERT … ON CONFLICT(board_type, climb_uuid, angle) DO UPDATE SET … WHERE excluded.sync_seq >=
  COALESCE(board_climb_stats.sync_seq, -1)`, and the snapshot import's `INSERT … SELECT FROM bs_snapshot`
  carries the same clause. Without it a page fetched before a recompute could commit after the stream had
  already written the newer row — its apply transaction waits behind whatever else holds the lock — and the
  row would read stale until the next cycle. The comparison is `>=`, not `>`: the pull usually carries the
  SAME revision the stream did, and that row still has to land, because it is what fills `updated_at`,
  `benchmark_difficulty` and the `fa_*` pair. Every other table keeps its unconditional `INSERT OR REPLACE`;
  they have exactly one writer, so there is nothing to lose a race with.

### `board_climb_grades` — `syncClimbGrades(boardType, layoutId?, sizeId?)` (board data, per-board)

- The nightly data-science Boardsesh grade (docs/boardsesh-grade.md). Scope: `board_type = $boardType`
  [`AND EXISTS (board_climbs bc WHERE bc.uuid = climb_uuid AND bc.layout_id = $layoutId AND
bc.compatible_size_ids @> ARRAY[$sizeId])` when scoped — the grades table has no `layout_id`, so it correlates
  back to `board_climbs`, identical to `board_climb_stats`]. Seq: **`sync_seq`**. **Cursor timestamp: `computed_at`**
  (this table has no `updated_at`). Hook: no.
- Local PK: **`(board_type, climb_uuid, angle)`**. table-config: `['board_type','climb_uuid','angle']`.
- Del: no deletion trigger today — grades are bulk-refreshed reference data (a full nightly recompute), not user
  writes. Because `localColumns` omits `updated_at`, the client's tombstone resurrection guard is a no-op for this
  table (a future grade tombstone would delete unconditionally — safe for reference data). If per-row grade
  deletions are ever added, encode `record_id = OLD.board_type:OLD.climb_uuid:OLD.angle` (3 segs), `user_id = NULL`.
- Columns: `board_type`, `climb_uuid`, `angle`, `local_grade` (REAL), `universal_grade` (REAL, NULL when
  unanchorable), `grade_low`, `grade_high` (REAL), `confidence` (TEXT tier), `ascensionist_count` (INTEGER snapshot),
  `computed_at` (ISO cursor timestamp), `sync_seq`. **`model_version`/`coeff_version`/`content_prior` are NOT synced**
  — the device only needs the surfaced grade + band.
- Local reads: the SQLite DDL adds this table in **migration v4** (a new-table CREATE, kept in migrations.ts like the
  v2 ALTER / v3 index, NOT in v1's SCHEMA_STATEMENTS). `search-climbs-local.ts` / `get-climb-local.ts` LEFT JOIN it on
  `(board_type, climb_uuid, angle)` and surface `boardsesh_difficulty = COALESCE(universal_grade, local_grade)` +
  `boardsesh_confidence`. The `boardseshGrade` / `boardseshGradesForAngles` GraphQL ops are served local-first from
  it (mobile `get-boardsesh-grade-local.ts` + the `offline-request.ts` registrations); those ops carry no
  layout/size, so they gate on the board TYPE being downloaded and treat a single-row miss as a network-retry.

### `spray_walls` — `syncSprayWalls(boardType, layoutId?, sizeId?)` (board data, per-board)

- The wall behind a spray board (issue #5448): its canonical frame, its published version, the holds alive at that
  version, that version's homography, and the private-bucket photo. Scope: the by-layout visibility rule — owner,
  gym member, or a PUBLIC wall — through the same `sprayLayoutIsReadable` gate `syncClimbs`, `syncClimbStats` and
  `syncClimbGrades` carry. Seq: **`spray_walls.id`** (the page selects it once, as `sync_seq`). Cursor timestamp:
  `updated_at`. Hook: no.
- **Unlisted is not an exemption on this key.** Unlisted means "reachable by uuid", and a layout id is not a uuid:
  it comes out of `spray_wall_catalog_id_seq`, so 1, 2, 3. Honouring unlisted here would let one authenticated
  account walk the sequence and collect a live presigned photograph of every unlisted home wall in the database.
  The uuid path that does honour unlisted is `sprayWall(uuid:)` / `sprayWallRenderData`, where the uuid itself is
  the capability. An unreadable, unscoped or non-spray request is an ordinary empty page — never an error and never
  a different shape — so nothing tells a caller which layout ids are private walls, and a page carries at most the
  one wall its scope key resolves to.
- Local PK: **`layout_id`**. table-config: `['layout_id']`.
- Del: migration `0228`. A wall is only ever SOFT-deleted (deleting the row would strand every climb set on it), so
  the trigger fires on `deleted_at` going NULL → NOT NULL and emits `record_id = OLD.layout_id::text` (1 seg) — the
  layout id, not the server bigserial, because `(board_type, layout_id)` is the only wall identity a phone can match
  a local row against. `user_id` is the wall's OWNER, not NULL: a NULL-scoped tombstone means "reference data, every
  client sees it", which is exactly what a private wall must never be. When the owner cannot be resolved the function
  warns and emits nothing rather than fall back to the global scope.
- Columns: `layout_id` (PK), `board_uuid`, `name` (read from the wall's `user_boards` row, where a wall's name,
  angle, visibility and gym all live), `reference_width`, `reference_height`, `current_version_number`, `photo_key`,
  `holds` (JSON text), `homography` (JSON text), `updated_at`, `sync_seq`.
- `holds` carries the holds alive at the published version (`aliveHolds`), fetched in a second round trip rather than
  re-expressed as a JSON aggregate in the page query: "which holds are on the wall right now" is a three-way range
  test over version status, and a second copy of it in SQL would be a second chance to draw holds that are not there.
  Hold edits land in a draft version and are invisible here until that draft publishes — and publishing bumps
  `spray_walls.updated_at`, so the cursor covers hold changes at the moment they become visible.
- **Transient: `photo_url`.** A 15-minute presigned URL over the PRIVATE bucket, emitted by the resolver, declared in
  `transientColumns`, and never stored. The pull client hands the committed page to `onDocumentsPulled`; the mobile
  sink fetches the bytes into a durable store under `Paths.document`, named after `photo_key`, and the URL is dropped.
  `photo_key` is the identity that survives — a stored signature would be stale, useless, and briefly live. Declaring
  it is not cosmetic: without it every pulled page would report schema drift for a column the resolver emits on
  purpose.
- Snapshots stay excluded. `SNAPSHOT_EXCLUDED_BOARD_TYPES` in `export-board-snapshots.ts` withholds `spray`, so no
  wall is ever baked into a nightly artifact and a manifest miss falls through to the paged crawl.
- Sign-out clears this table: `spray_walls` is the one entry in `USER_DATA_TABLES_TO_CLEAR` that is board reference
  data, and the photographs are wiped with it. See the spray-wall subsection of the auth-scoping contract in
  [`offline-reads.md`](offline-reads.md).

### `user_playlist_pins` — NOT synced

- No sync resolver (not among the 10). Gets `updated_at` in Phase 2 for consistency only. No local sync table needed.
  The mutation-queue pin/unpin handlers stay (queue-only); there is no offline pin UI.

---

## `:`-delimiter safety (I18)

Multi-segment `record_id`s only ever join columns whose value domains exclude `:`:
`board_name`∈{kilter,tension}, `angle`∈int, `climb_uuid`/`playlist_uuid`=uuids, `board_type`∈{kilter,tension}.
Single-segment encodings (`uuid`, `following_id`, `setter_username`, `playlist_uuid`) are never split. So
splitting on `:` with a fixed expected segment count is safe. `pull-client.ts` already guards mismatched counts.
