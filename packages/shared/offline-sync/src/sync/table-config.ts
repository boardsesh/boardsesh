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
      'updated_at',
      'sync_seq',
    ],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    cursorColumn: UPDATED_AT_CURSOR,
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
