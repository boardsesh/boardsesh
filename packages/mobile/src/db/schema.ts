// On-device SQLite DDL for the Boardsesh mobile app.
//
// Column names, types, and primary keys are governed by docs/sync-table-manifest.md
// — the cross-package contract. The sync pull client does
// `INSERT OR REPLACE INTO <table> (<Object.keys(doc)>)`, so every column here MUST
// match the snake_case key the backend resolver emits, to the character.
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
