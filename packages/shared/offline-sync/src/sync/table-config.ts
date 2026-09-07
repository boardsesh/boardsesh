import { TABLE_INVALIDATE_KEYS, type InvalidateKeys } from './invalidate-keys';

export type TableSyncConfig = {
  queryName: string;
  operationKey: string;
  isPerBoard: boolean;
  /**
   * Query keys a completed pull of this table busts. NOT declared per entry —
   * resolved below from the single `TABLE_INVALIDATE_KEYS` map so this file and
   * the mutation drainer cannot drift apart again (they both used to carry a
   * copy, and both copies pointed at keys no reader used).
   */
  invalidateKeys: InvalidateKeys;
  primaryKeyColumns: string[];
  localColumns: readonly string[];
  /**
   * Fields the resolver emits that are deliberately NOT stored — handed to the
   * `onDocumentsPulled` sink and then dropped.
   *
   * Exactly one field uses this today: `spray_walls.photo_url`, a 15-minute
   * presigned signature over an object in the PRIVATE bucket. The device needs
   * it to fetch the bytes and must not keep it: the backend's own rule is
   * "minted per read and never stored" (`presignVersionPhoto`), and a row that
   * carried the URL would hand a stale, useless, and briefly live signature to
   * anything that read the wall.
   *
   * Listing it here is not cosmetic — without it every pulled page reports a
   * schema-drift event for a column the resolver is emitting on purpose.
   */
  transientColumns?: readonly string[];
  /**
   * Columns to read out of a row BEFORE a tombstone deletes it, handed to the
   * `onRowsDeleted` sink afterwards.
   *
   * One user today: `spray_walls.photo_key`. The generic deletion processor
   * deletes by primary key and knows nothing about files, so once the row is
   * gone nothing on the device can say which JPEG belonged to it — not the board
   * teardown (its row is missing) and not the photo sink (it only sees walls the
   * device still has). Captured here, the platform can delete the bytes.
   */
  captureOnDelete?: readonly string[];
  /** Bump when existing reference rows need newly synced fields backfilled. */
  refreshRevision?: number;
  /** Cumulative fields that must be present before coverage can be stamped. */
  refreshColumns?: readonly string[];
  /**
   * The timestamp half of this table's `(timestamp, sync_seq)` keyset cursor —
   * whatever the resolver passes as `updatedAtColumn` in
   * packages/backend/src/graphql/resolvers/sync/queries.ts. Almost every table
   * cursors on `updated_at`; `board_climb_grades` cursors on `computed_at`
   * because grades are bulk-recomputed reference data, not user writes.
   *
   * Declared HERE rather than duplicated in the nightly export job and the
   * snapshot import so the two can never disagree about which column a
   * watermark covers. Disagreement is a data-loss bug in one direction: a
   * watermark read off the wrong column can cover rows the artifact never
   * carried, and the strict `>` delta pull never revisits them.
   */
  cursorColumn: string;
  /**
   * When set, the pull upserts this table with a revision guard instead of an
   * unconditional `INSERT OR REPLACE`: an incoming row is only allowed to
   * overwrite a local one when `excluded.<revisionColumn> >= COALESCE(local, -1)`.
   *
   * Only for tables with a SECOND local writer. `board_climb_stats` has one
   * (the live `climbStatsUpdated` write-through, #5227), and a pull page can
   * commit up to 5 s after it was fetched — long enough for the stream to have
   * landed a newer row that the page would otherwise revert until the next
   * cycle. Every other table has exactly one writer, so a guard there would buy
   * nothing and cost a wider statement.
   *
   * The comparison is `>=`, not `>`: the pull usually carries the SAME revision
   * the stream did, and that row must still be applied because it fills the
   * columns the stream deliberately leaves alone (`updated_at`, which is the
   * pull cursor, plus `benchmark_difficulty` and the `fa_*` pair).
   */
  revisionColumn?: string;
};

type TableSyncDefinition = Omit<TableSyncConfig, 'invalidateKeys'>;

/** The cursor column all but one sync table uses. */
const UPDATED_AT_CURSOR = 'updated_at';

const TABLE_SYNC_DEFINITIONS: Record<string, TableSyncDefinition> = {
  boardsesh_ticks: {
    queryName: 'syncTicks',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_TICKS',
    isPerBoard: false,
    primaryKeyColumns: ['uuid'],
    localColumns: [
      'uuid',
      'user_id',
      'board_type',
      'climb_uuid',
      'angle',
      'is_mirror',
      'status',
      'attempt_count',
      'quality',
      'difficulty',
      'is_benchmark',
      'comment',
      'climbed_at',
      'session_id',
      'created_at',
      'updated_at',
    ],
  },
  playlists: {
    queryName: 'syncPlaylists',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_PLAYLISTS',
    isPerBoard: false,
    primaryKeyColumns: ['uuid'],
    localColumns: [
      'uuid',
      'board_type',
      'layout_id',
      'name',
      'description',
      'is_public',
      'color',
      'icon',
      'created_at',
      'updated_at',
      'last_accessed_at',
    ],
  },
  playlist_climbs: {
    queryName: 'syncPlaylistClimbs',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_PLAYLIST_CLIMBS',
    isPerBoard: false,
    primaryKeyColumns: ['playlist_uuid', 'climb_uuid'],
    localColumns: ['playlist_uuid', 'climb_uuid', 'angle', 'position', 'added_at', 'updated_at'],
  },
  user_favorites: {
    queryName: 'syncFavorites',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_FAVORITES',
    isPerBoard: false,
    primaryKeyColumns: ['board_name', 'climb_uuid', 'angle'],
    localColumns: ['board_name', 'climb_uuid', 'angle', 'user_id', 'created_at', 'updated_at'],
  },
  user_follows: {
    queryName: 'syncUserFollows',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_USER_FOLLOWS',
    isPerBoard: false,
    primaryKeyColumns: ['following_id'],
    localColumns: ['following_id', 'follower_id', 'created_at', 'updated_at'],
  },
  setter_follows: {
    queryName: 'syncSetterFollows',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_SETTER_FOLLOWS',
    isPerBoard: false,
    primaryKeyColumns: ['setter_username'],
    localColumns: ['setter_username', 'follower_id', 'created_at', 'updated_at'],
  },
  playlist_follows: {
    queryName: 'syncPlaylistFollows',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_PLAYLIST_FOLLOWS',
    isPerBoard: false,
    primaryKeyColumns: ['playlist_uuid'],
    localColumns: ['playlist_uuid', 'follower_id', 'created_at', 'updated_at'],
  },
  board_climbs: {
    refreshRevision: 1,
    refreshColumns: ['is_hidden'],
    queryName: 'syncClimbs',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_CLIMBS',
    isPerBoard: true,
    primaryKeyColumns: ['uuid'],
    localColumns: [
      'uuid',
      'board_type',
      'layout_id',
      'setter_id',
      'setter_username',
      'name',
      'description',
      'hsm',
      'edge_left',
      'edge_right',
      'edge_bottom',
      'edge_top',
      'angle',
      'frames_count',
      'frames_pace',
      'frames',
      'is_draft',
      'is_listed',
      'is_hidden',
      'created_at',
      'published_at',
      'user_id',
      'required_set_ids',
      'compatible_size_ids',
      'characteristics',
      'hold_fingerprint',
      // Spray-wall hold integrity (SW-15, #5448): how many of this climb's holds
      // have since come off the wall, so `search-climbs-local.ts` can answer the
      // Intact / Lost-holds filter instead of declining it.
      //
      // ADDED WITHOUT BUMPING `refreshRevision` / `refreshColumns`, on purpose.
      // A bump means "every already-downloaded scope must re-crawl to backfill
      // this field" — that is every enabled Kilter and Tension catalogue, tens of
      // thousands of rows each, to fill in a column that is NULL on all of them
      // (holds do not come off a catalogue board; only a spray reset writes it).
      // Spray scopes are new in this release, so no checkpoint predating this
      // column can exist for one, and the local predicate is NULL-safe
      // (`COALESCE(missing_hold_count, 0)`) for every row pulled before it — the
      // same "unknown reads as intact" rule the server's `holdIntegrityCondition`
      // applies. The two conditions a bump exists to protect are therefore both
      // already met, and paying for it would be a catalogue replay for nothing.
      'missing_hold_count',
      'updated_at',
      'sync_seq',
    ],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    cursorColumn: UPDATED_AT_CURSOR,
    // The one table the live stream also writes, so the pull must not be able
    // to walk a newer local row backwards. See `revisionColumn` above.
    revisionColumn: 'sync_seq',
    operationKey: 'SYNC_CLIMB_STATS',
    isPerBoard: true,
    primaryKeyColumns: ['board_type', 'climb_uuid', 'angle'],
    localColumns: [
      'board_type',
      'climb_uuid',
      'angle',
      'display_difficulty',
      'benchmark_difficulty',
      'ascensionist_count',
      'difficulty_average',
      'quality_average',
      'fa_username',
      'fa_at',
      'updated_at',
      'sync_seq',
    ],
  },
  board_climb_grades: {
    queryName: 'syncClimbGrades',
    // The one table that does NOT cursor on updated_at — it has no such column.
    // Matches `updatedAtColumn: sql`board_climb_grades.computed_at`` in the
    // syncClimbGrades resolver.
    cursorColumn: 'computed_at',
    // operationKey is a label only — the pull client builds the query from
    // queryName (buildSyncQuery), so no separate registered SYNC_CLIMB_GRADES
    // document is needed, exactly like SYNC_CLIMB_STATS.
    operationKey: 'SYNC_CLIMB_GRADES',
    isPerBoard: true,
    primaryKeyColumns: ['board_type', 'climb_uuid', 'angle'],
    // Matches the syncClimbGrades selectList (packages/backend/.../sync/queries.ts):
    // model_version/coeff_version/content_prior are NOT pulled — the device only
    // needs the surfaced grade + band. The timestamp column is computed_at, not
    // updated_at (so the deletion resurrection guard is a no-op for grades — grades
    // are bulk-refreshed reference data, not user writes).
    localColumns: [
      'board_type',
      'climb_uuid',
      'angle',
      'local_grade',
      'universal_grade',
      'grade_low',
      'grade_high',
      'confidence',
      'ascensionist_count',
      'computed_at',
      'sync_seq',
    ],
  },
  spray_walls: {
    queryName: 'syncSprayWalls',
    cursorColumn: UPDATED_AT_CURSOR,
    operationKey: 'SYNC_SPRAY_WALLS',
    // Per-board, and the scope is never optional in practice: `syncSprayWalls`
    // answers an empty page unless the caller names a layout it may read, so a
    // page carries at most the one wall that scope key resolves to.
    isPerBoard: true,
    primaryKeyColumns: ['layout_id'],
    // Matches the syncSprayWalls selectList, and the tombstone trigger's
    // single-segment `record_id` (migration 0228 writes `layout_id::text`).
    localColumns: [
      'layout_id',
      'board_uuid',
      'name',
      'reference_width',
      'reference_height',
      'current_version_number',
      'photo_key',
      'holds',
      'homography',
      'updated_at',
      'sync_seq',
    ],
    // The presigned photo URL rides along and is never written. See the field's
    // docblock on TableSyncConfig above.
    transientColumns: ['photo_url'],
    // A wall tombstone has to take the photograph with it; the row is the only
    // thing that names the file.
    captureOnDelete: ['layout_id', 'photo_key'],
  },
};

/**
 * Every syncable table, with its invalidation keys attached from the shared map.
 * A table missing from that map resolves to `[]` rather than crashing the sync
 * cycle; `invalidate-keys-drift.test.ts` is what fails loudly on the omission.
 */
export const TABLE_CONFIGS: Record<string, TableSyncConfig> = Object.fromEntries(
  Object.entries(TABLE_SYNC_DEFINITIONS).map(([tableName, definition]) => [
    tableName,
    { ...definition, invalidateKeys: TABLE_INVALIDATE_KEYS[tableName] ?? [] },
  ]),
);

export const USER_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => !config.isPerBoard)
  .map(([tableName]) => tableName);

export const BOARD_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => config.isPerBoard)
  .map(([tableName]) => tableName);
