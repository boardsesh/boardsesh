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
   * Columns the device table still HAS and the sync no longer writes. The
   * server still sends them and an artifact still carries them, so like a
   * transient field they are skipped without a drift report; unlike one they
   * exist in the table, where a row written from here on leaves them NULL.
   *
   * A column is retired here first and dropped from the schema by a later
   * migration, because an older bundle on the same phone has to keep working
   * against whatever schema this one leaves. Today: the first-ascent pair of
   * `board_climb_stats` (`STATS_FIRST_ASCENT_COLUMNS`).
   */
  retiredColumns?: readonly string[];
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
  /**
   * A higher refresh revision for one board type only, so a field that only
   * one board ever writes can be backfilled without re-crawling every other
   * board's downloaded catalogue. The effective revision for a scope is the
   * larger of this and `refreshRevision` (`refreshRevisionFor`).
   */
  refreshRevisionByBoardType?: Readonly<Partial<Record<string, number>>>;
  /** Extra `refreshColumns` for one board type's scopes, merged by `refreshColumnsFor`. */
  refreshColumnsByBoardType?: Readonly<Partial<Record<string, readonly string[]>>>;
  /** Cumulative fields that must be present before coverage can be stamped. */
  refreshColumns?: readonly string[];
  /**
   * The resolver takes the `audience` argument, so this table is pulled as two
   * streams (see `boardSyncStreamsFor`). Set on `syncClimbs`, `syncClimbStats`
   * and `syncClimbGrades`; `syncSprayWalls` has no such argument and one
   * viewer-scoped stream.
   */
  takesAudience?: boolean;
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

/**
 * Every field of a table's sync document that is known and not written: its
 * transient fields and its retired columns. What a page writer and an artifact
 * import skip without reporting drift.
 */
export function unstoredColumnsOf(config: Pick<TableSyncConfig, 'transientColumns' | 'retiredColumns'>): string[] {
  return [...(config.transientColumns ?? []), ...(config.retiredColumns ?? [])];
}

/** The cursor column all but one sync table uses. */
const UPDATED_AT_CURSOR = 'updated_at';

/**
 * The first-ascent credit of a stats row. The server and the snapshot artifact
 * carry it (the stored upstream credit of a climb that never had a Boardsesh
 * author, NULL otherwise), and the device does NOT store it: no offline reader
 * selects either column, and a name kept on a phone is one more thing to take
 * back when a climber's privacy changes (issue #6306).
 *
 * The columns stay in the device schema, unused. Dropping them is a schema
 * change an older bundle on the same phone would have to survive, so it is a
 * later step; until then a page or an import leaves them NULL, and the
 * platform blanks once what an earlier bundle stored.
 */
export const STATS_FIRST_ASCENT_COLUMNS = ['fa_username', 'fa_at'] as const;

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
      // The climb revision the tick was logged against (#6023). NULL on a tick
      // pulled before schema v11 and on every import; both mean unknown.
      'climb_revision',
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
    // Spray scopes replay once more for `retired_by_reset` (#6024). A full reset
    // stamps `updated_at` on every climb it retires, but a phone on an older
    // bundle took those rows through the ordinary cursor and dropped the field,
    // so they would stay NULL (not retired) here for good. Spray only: no
    // catalogue board ever sets the flag, and bumping `refreshRevision` would
    // re-crawl every downloaded Kilter and Tension catalogue to write NULLs.
    refreshRevisionByBoardType: { spray: 2 },
    refreshColumns: ['is_hidden'],
    // Required on spray pages only. A page from a server that predates the
    // column must not complete the spray replay above, but making it required
    // everywhere would let one such page reopen coverage on every catalogue.
    refreshColumnsByBoardType: { spray: ['retired_by_reset'] },
    queryName: 'syncClimbs',
    takesAudience: true,
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
      // have since come off the wall, so `search-climbs-local.ts` can keep a
      // published climb that lost a hold out of the listings, as the server does.
      //
      // ADDED WITHOUT BUMPING `refreshRevision` / `refreshColumns`, on purpose.
      // A bump means "every already-downloaded scope must re-crawl to backfill
      // this field" — that is every enabled Kilter and Tension catalogue, tens of
      // thousands of rows each, to fill in a column that is NULL on all of them
      // (holds do not come off a catalogue board; only a spray hold edit writes it).
      // Spray scopes are new in this release, so no checkpoint predating this
      // column can exist for one, and every local reader is NULL-safe (NULL reads
      // as no hold lost, so no badge) for every row pulled before it — the same
      // "unknown reads as intact" rule the server's `holdIntegrityCondition`
      // applies. The two conditions a bump exists to protect are therefore both
      // already met, and paying for it would be a catalogue replay for nothing.
      'missing_hold_count',
      // The climb's current revision and the revision at which its holds last
      // changed (#6023).
      //
      // ALSO ADDED WITHOUT BUMPING `refreshRevision` / `refreshColumns`. The
      // server default is 1 and only an edit moves it, and an edit bumps the
      // row's `sync_seq`, so every climb whose number is not 1 is re-delivered
      // by the ordinary cursor. A row that is never re-delivered is a climb
      // nobody has edited, and its NULL here is safe: a tick logged from it
      // sends no revision and the server stores 1. A bump would re-crawl every
      // downloaded catalogue to write a 1 beside each climb.
      //
      // One gap, which is why a local reader must take NULL as unknown and not
      // as 1: a climb edited while this phone ran an older bundle was
      // re-delivered to code that dropped the two fields, and stays NULL until
      // its next edit. The server's by-date fallback still stamps that tick
      // correctly.
      'revision_number',
      'holds_revision_number',
      // Spray climbs retired by a full reset (#6024), so the local search can
      // hide them from a wall's default list the way the server does.
      //
      // No table-wide `refreshRevision` / `refreshColumns` bump: only a full
      // reset sets it, the recompute that sets it stamps `updated_at`, and so
      // the ordinary cursor re-delivers every row it touches. NULL reads as not
      // retired, which is right for every catalogue climb. Spray scopes DO get
      // a bump (`refreshRevisionByBoardType` / `refreshColumnsByBoardType`
      // above), so a spray row re-delivered to an older bundle that dropped the
      // field is backfilled by that one replay.
      'retired_by_reset',
      'updated_at',
      'sync_seq',
    ],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    takesAudience: true,
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
      'updated_at',
      'sync_seq',
    ],
    retiredColumns: STATS_FIRST_ASCENT_COLUMNS,
  },
  board_climb_grades: {
    queryName: 'syncClimbGrades',
    takesAudience: true,
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
    captureOnDelete: ['layout_id', 'board_uuid', 'photo_key'],
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

/**
 * The refresh revision a board scope of `tableName` must reach: the table-wide
 * `refreshRevision`, raised by `refreshRevisionByBoardType` for that board.
 * Undefined when the table has neither, which means "never replay".
 */
export function refreshRevisionFor(tableName: string, boardType: string | undefined): number | undefined {
  const config = TABLE_CONFIGS[tableName];
  if (!config) return undefined;
  const boardRevision = boardType ? config.refreshRevisionByBoardType?.[boardType] : undefined;
  const revision = Math.max(config.refreshRevision ?? 0, boardRevision ?? 0);
  return revision > 0 ? revision : undefined;
}

/** The refresh columns a board scope of `tableName` requires: the table's, plus that board's. */
export function refreshColumnsFor(tableName: string, boardType: string | undefined): readonly string[] {
  const config = TABLE_CONFIGS[tableName];
  if (!config) return [];
  const boardColumns = boardType ? (config.refreshColumnsByBoardType?.[boardType] ?? []) : [];
  return [...(config.refreshColumns ?? []), ...boardColumns];
}

export const USER_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => !config.isPerBoard)
  .map(([tableName]) => tableName);

export const BOARD_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => config.isPerBoard)
  .map(([tableName]) => tableName);

/**
 * One of the two streams a per-board table is pulled through (issue #6306).
 *
 *  - `reference`: every published and listed climb, whoever set it, with its
 *    stats and grades. The same rows for every viewer and exactly the rows a
 *    snapshot artifact carries, so its cursor is the artifact's watermark after
 *    an import. No privacy setting applies to it.
 *  - `protected`: the rows only this viewer is sent. On a catalogue board that
 *    is the climber's own drafts and unlisted climbs, a handful of rows that
 *    change with the ACCOUNT and not with anybody's privacy settings. On a
 *    spray wall it is everything, and it does depend on privacy
 *    (`isPrivacyScopedBoardType`).
 *
 * A climb that stops being published and listed leaves the reference stream.
 * The server writes a `board_climbs` deletion marker for it, so every device
 * drops its copy, and its owner gets it back through the protected stream.
 */
export type BoardSyncStream = 'reference' | 'protected';

/**
 * Board types with no reference set: nothing of theirs is ever in a snapshot
 * artifact, so everything arrives through the protected stream. Mirrors the
 * backend's `REFERENCE_EXCLUDED_BOARD_TYPES`, as a literal because this package
 * has no dependency on `@boardsesh/db`.
 *
 * The two lists may drift without losing a row. The server answers `REFERENCE`
 * with an empty page for a board type it excludes and `PROTECTED` with every
 * row the viewer may see, so a board type missing here costs three empty
 * requests a cycle and nothing else.
 */
const BOARD_TYPES_WITHOUT_REFERENCE: ReadonlySet<string> = new Set(['spray']);

/** Whether a board type has rows that are public for every viewer. */
export function hasReferenceStream(boardType: string): boolean {
  return !BOARD_TYPES_WITHOUT_REFERENCE.has(boardType);
}

/**
 * Whether a board type's protected stream depends on privacy: who may see a
 * spray wall changes with its sharing, a gym's members and account privacy. A
 * privacy event withdraws such a board's rows and makes the device ask again.
 *
 * Every other board's protected stream is the climber's own rows, which no
 * privacy event changes, so nothing of theirs is withdrawn, fenced or replayed
 * for one. The same set as "has no reference stream" today, and named apart
 * because the two answer different questions.
 */
export function isPrivacyScopedBoardType(boardType: string): boolean {
  return BOARD_TYPES_WITHOUT_REFERENCE.has(boardType);
}

/** The board types `isPrivacyScopedBoardType` answers true for. */
export const PRIVACY_SCOPED_BOARD_TYPES: readonly string[] = [...BOARD_TYPES_WITHOUT_REFERENCE];

/**
 * The streams one board scope pulls `tableName` through, in pull order.
 *
 * A table whose resolver takes `audience` splits in two, reference first. A
 * table without it (`spray_walls`) is one viewer-scoped stream, so it is
 * protected, and only a board type that has walls asks for it at all: the
 * server answers every other board type with an empty page.
 */
export function boardSyncStreamsFor(tableName: string, boardType: string): readonly BoardSyncStream[] {
  const config = TABLE_CONFIGS[tableName];
  if (!config?.isPerBoard) return [];
  if (!config.takesAudience) return hasReferenceStream(boardType) ? [] : ['protected'];
  return hasReferenceStream(boardType) ? ['reference', 'protected'] : ['protected'];
}
