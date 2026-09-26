// On-device SQLite DDL for the Boardsesh mobile app.
//
// Column names, types, and primary keys are governed by docs/sync-table-manifest.md
// — the cross-package contract. The sync pull client accepts only the per-table
// column allowlist in sync/table-config.ts, so every column here MUST match the
// snake_case key the backend resolver emits, to the character.
//
// Type rules (per manifest):
//   - booleans  → INTEGER (0/1; the upsert maps JS booleans)
//   - arrays / Postgres `int[]` / JSON → TEXT holding a JSON string
//   - timestamps → TEXT (ISO-8601)
//   - everything else → TEXT / INTEGER / REAL as the column's value domain dictates
//
// Local PKs deliberately OMIT the user-scoping column (user_id / follower_id): the
// device holds exactly one user's data, so the natural key is unique and lets an
// offline write dedupe against the later synced row via INSERT OR REPLACE. The
// user-scoping column is still present as a nullable column (filled on sync).
//
// DDL is exported as plain SQL strings so node-based tests can run them against a
// non-native SQLite (no Metro / expo-sqlite required).

import { MUTATION_QUEUE_SCHEMA } from '../mutation-queue/schema';

// --- User data tables ---------------------------------------------------------

const BOARDSESH_TICKS = `
CREATE TABLE IF NOT EXISTS boardsesh_ticks (
  uuid TEXT PRIMARY KEY,
  user_id TEXT,
  board_type TEXT,
  climb_uuid TEXT,
  angle INTEGER,
  is_mirror INTEGER,
  status TEXT,
  attempt_count INTEGER,
  quality INTEGER,
  difficulty INTEGER,
  is_benchmark INTEGER,
  comment TEXT,
  climbed_at TEXT,
  session_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

const PLAYLISTS = `
CREATE TABLE IF NOT EXISTS playlists (
  uuid TEXT PRIMARY KEY,
  board_type TEXT,
  layout_id INTEGER,
  name TEXT,
  description TEXT,
  is_public INTEGER,
  color TEXT,
  icon TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_accessed_at TEXT
);
`;

const PLAYLIST_CLIMBS = `
CREATE TABLE IF NOT EXISTS playlist_climbs (
  playlist_uuid TEXT NOT NULL,
  climb_uuid TEXT NOT NULL,
  angle INTEGER,
  position INTEGER,
  added_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (playlist_uuid, climb_uuid)
);
`;

const USER_FAVORITES = `
CREATE TABLE IF NOT EXISTS user_favorites (
  board_name TEXT NOT NULL,
  climb_uuid TEXT NOT NULL,
  angle INTEGER NOT NULL,
  user_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (board_name, climb_uuid, angle)
);
`;

const USER_FOLLOWS = `
CREATE TABLE IF NOT EXISTS user_follows (
  following_id TEXT PRIMARY KEY,
  follower_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

const SETTER_FOLLOWS = `
CREATE TABLE IF NOT EXISTS setter_follows (
  setter_username TEXT PRIMARY KEY,
  follower_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

const PLAYLIST_FOLLOWS = `
CREATE TABLE IF NOT EXISTS playlist_follows (
  playlist_uuid TEXT PRIMARY KEY,
  follower_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

// --- Board reference data tables ----------------------------------------------
// Dormant this phase (climb search is not repointed to local SQLite yet), but
// built correct so syncEnabledBoards can flip them on without a schema change.

const BOARD_CLIMBS = `
CREATE TABLE IF NOT EXISTS board_climbs (
  uuid TEXT PRIMARY KEY,
  board_type TEXT,
  layout_id INTEGER,
  setter_id INTEGER,
  setter_username TEXT,
  name TEXT,
  description TEXT,
  hsm INTEGER,
  edge_left INTEGER,
  edge_right INTEGER,
  edge_bottom INTEGER,
  edge_top INTEGER,
  angle INTEGER,
  frames_count INTEGER,
  frames_pace INTEGER,
  frames TEXT,
  is_draft INTEGER,
  is_listed INTEGER,
  created_at TEXT,
  published_at TEXT,
  user_id TEXT,
  required_set_ids TEXT,
  compatible_size_ids TEXT,
  hold_fingerprint TEXT,
  updated_at TEXT,
  sync_seq INTEGER
);
`;

const BOARD_CLIMB_STATS = `
CREATE TABLE IF NOT EXISTS board_climb_stats (
  board_type TEXT NOT NULL,
  climb_uuid TEXT NOT NULL,
  angle INTEGER NOT NULL,
  display_difficulty REAL,
  benchmark_difficulty REAL,
  ascensionist_count INTEGER,
  difficulty_average REAL,
  quality_average REAL,
  fa_username TEXT,
  fa_at TEXT,
  updated_at TEXT,
  sync_seq INTEGER,
  PRIMARY KEY (board_type, climb_uuid, angle)
);
`;

/**
 * One spray wall: the geometry and photo identity a garage wall needs in order
 * to draw itself with no signal (issue #5448).
 *
 * Deliberately NOT part of `SCHEMA_STATEMENTS`. Like `board_climb_grades`, this
 * table arrives in a later migration (v8) rather than by editing v1's shipped
 * statement list. The DDL text still lives here because this file is the one
 * home for on-device DDL; `migrations.ts` imports it.
 *
 * `layout_id` is the primary key because that is what the rest of the mirror
 * already knows a wall by: `board_climbs.layout_id`, the offline board scope key
 * `spray:<layoutId>:<layoutId>`, and the single-segment `record_id` that
 * migration 0228's tombstone trigger writes. A wall is exactly one layout, so it
 * is a natural key and a tombstone needs no re-encoding.
 *
 * `holds` and `homography` are JSON strings (the manifest's rule for arrays and
 * JSON): respectively the holds ALIVE at `current_version_number`, and that
 * version's row-major 3x3 photo→canonical matrix. The photo itself is not here —
 * `photo_key` names a file the photo store keeps on disk, because a
 * multi-megabyte JPEG has no business in a SQLite row, and the presigned URL it
 * is fetched with is short-lived and is never persisted at all.
 */
export const SPRAY_WALLS = `
CREATE TABLE IF NOT EXISTS spray_walls (
  layout_id INTEGER PRIMARY KEY,
  board_uuid TEXT,
  name TEXT,
  reference_width INTEGER,
  reference_height INTEGER,
  current_version_number INTEGER,
  photo_key TEXT,
  holds TEXT,
  homography TEXT,
  updated_at TEXT,
  sync_seq INTEGER
);
`.trim();

/**
 * The device-derived holds index (holds-index/). Three tables, all built on the
 * phone from `board_climbs.frames`, never synced, never tombstoned, never shipped
 * in a snapshot artifact. The byte formats are in holds-index/query.ts.
 *
 * Packed blobs rather than one row per hold: a Kilter download is ~3.8M
 * hold rows, which as rows costs ~370 MB on the phone.
 *
 * Two rules for this DDL text, both enforced by the snapshot export
 * (`boardSnapshotDdlStatements`, which picks the artifact's DDL out of MIGRATIONS
 * with a word-boundary regex on `board_climbs`): no SQL comments, which could name
 * `board_climbs`, and no `REFERENCES board_climbs`. Commentary stays here in TS.
 *
 * Deliberately NOT part of `SCHEMA_STATEMENTS`: they arrive in migration v10.
 */

/**
 * A stable local integer id per climb uuid, so a posting is 4 bytes per climb
 * instead of a 36-character uuid. Rows are only ever `INSERT OR IGNORE`d, and
 * `AUTOINCREMENT` means a deleted id is never handed out again: an id that a
 * stale posting still names can never come to mean a different climb.
 */
export const HOLDS_INDEX_CLIMBS = `
CREATE TABLE IF NOT EXISTS holds_index_climbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE
);
`.trim();

/** One row per indexed climb: its holds, sorted, 5 bytes each (uint32 hold id + uint8 role). */
export const BOARD_CLIMB_HOLD_SETS = `
CREATE TABLE IF NOT EXISTS board_climb_hold_sets (
  climb_id INTEGER PRIMARY KEY,
  holds BLOB NOT NULL
);
`.trim();

/**
 * One row per (board, layout, hold): the sorted uint32 local ids of the indexed
 * climbs that use it. Per LAYOUT, shared by every downloaded size of it.
 */
export const BOARD_CLIMB_HOLD_POSTINGS = `
CREATE TABLE IF NOT EXISTS board_climb_hold_postings (
  board_type TEXT NOT NULL,
  layout_id INTEGER NOT NULL,
  hold_id INTEGER NOT NULL,
  climb_ids BLOB NOT NULL,
  PRIMARY KEY (board_type, layout_id, hold_id)
) WITHOUT ROWID;
`.trim();

/**
 * `board_climbs` by change counter within a layout. The holds index builder
 * reads climbs in `sync_seq` order from a per-scope watermark, and its
 * "is the index behind?" probe is `sync_seq > ? LIMIT 1`; without this index
 * both sort the whole layout on every call.
 *
 * It names `board_climbs`, which the snapshot export's table match would pull
 * into every artifact, where it is dead weight (the import copies rows out of
 * the attached artifact and never queries it by `sync_seq`). It is therefore in
 * DEVICE_ONLY_STATEMENTS below, which the export leaves out.
 */
export const INDEX_CLIMBS_SYNC_SEQ = `
CREATE INDEX IF NOT EXISTS idx_climbs_sync_seq ON board_climbs (board_type, layout_id, sync_seq);
`.trim();

/**
 * Tables the device builds for itself and that must never leave it: not synced
 * (no `TABLE_CONFIGS` entry), not in a snapshot artifact. The snapshot export
 * refuses to emit DDL naming one of these, and the explicit sign-out wipe clears
 * them alongside the board tables.
 */
export const DEVICE_ONLY_TABLES = ['holds_index_climbs', 'board_climb_hold_sets', 'board_climb_hold_postings'] as const;

/**
 * Migration statements the device needs but a snapshot artifact must not carry,
 * although they touch an artifact table. The export drops these by exact text,
 * so moving one requires no artifact format change.
 */
export const DEVICE_ONLY_STATEMENTS: readonly string[] = [INDEX_CLIMBS_SYNC_SEQ];

// --- Sync bookkeeping ---------------------------------------------------------
// checkpoints.ts reads/writes sync_meta(key, value); it has no CREATE TABLE of
// its own, so the table is created here.

const SYNC_META = `
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// --- Indexes ------------------------------------------------------------------

const INDEX_TICKS_LOGBOOK = `
CREATE INDEX IF NOT EXISTS idx_ticks_climb ON boardsesh_ticks (climb_uuid, board_type, angle);
`;

const INDEX_CLIMBS_SEARCH = `
CREATE INDEX IF NOT EXISTS idx_climbs_search ON board_climbs (board_type, layout_id, is_listed);
`;

const INDEX_STATS_LOOKUP = `
CREATE INDEX IF NOT EXISTS idx_stats_lookup ON board_climb_stats (board_type, climb_uuid, angle);
`;

const INDEX_STATS_DIFFICULTY = `
CREATE INDEX IF NOT EXISTS idx_stats_difficulty ON board_climb_stats (board_type, angle, display_difficulty);
`;

const INDEX_PENDING_MUTATIONS = `
CREATE INDEX IF NOT EXISTS idx_pending_mutations_status ON pending_mutations (status, created_at);
`;

// Ordered list of every DDL statement the app needs at version 1. Tables come
// before the indexes that reference them; pending_mutations is created by
// MUTATION_QUEUE_SCHEMA before its index so `runMigrations` alone is sufficient
// even if `ensureMutationQueueTable` has not run yet.
export const SCHEMA_STATEMENTS: string[] = [
  BOARDSESH_TICKS,
  PLAYLISTS,
  PLAYLIST_CLIMBS,
  USER_FAVORITES,
  USER_FOLLOWS,
  SETTER_FOLLOWS,
  PLAYLIST_FOLLOWS,
  BOARD_CLIMBS,
  BOARD_CLIMB_STATS,
  SYNC_META,
  MUTATION_QUEUE_SCHEMA,
  INDEX_TICKS_LOGBOOK,
  INDEX_CLIMBS_SEARCH,
  INDEX_STATS_LOOKUP,
  INDEX_STATS_DIFFICULTY,
  INDEX_PENDING_MUTATIONS,
].map((statement) => statement.trim());
