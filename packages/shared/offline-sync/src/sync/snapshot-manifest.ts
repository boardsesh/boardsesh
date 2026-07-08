// The board-snapshot manifest contract, shared by the backend export job that
// writes it (packages/backend/scripts/export-board-snapshots.ts) and the client
// bootstrap that reads it (Phase 3, pull-client). One JSON object published at
// `board-snapshots/v1/manifest.json`; each entry points a downloaded board at a
// pre-built SQLite artifact plus the watermarks a client resumes its
// incremental pull from.
//
// Pure types + a hand-rolled validator (this package intentionally ships zero
// runtime dependencies, so no zod). Bump `formatVersion` on any breaking shape
// change so an old client rejects a manifest it can't parse rather than acting
// on partial data.

/** The two reference-data tables a snapshot carries. */
export type SnapshotTableName = 'board_climbs' | 'board_climb_stats';

/** Per-table watermark + row count, the resume point for an incremental pull. */
export type SnapshotTableStats = {
  // ISO-8601 UTC. The max `updated_at` across the rows actually exported.
  watermarkUpdatedAt: string;
  // The `sync_seq` paired with `watermarkUpdatedAt` (the composite keyset cursor
  // the sync resolvers page on: `(updated_at, sync_seq)`). Carried as a decimal
  // string, like every seq in the sync protocol, so a Postgres bigint can never
  // lose precision in a JS number.
  watermarkSyncSeq: string;
  rowCount: number;
};

export type SnapshotManifestEntry = {
  boardType: string;
  layoutId: number;
  // S3 object key of the artifact, e.g. `board-snapshots/v1/kilter/8/<iso>.db`.
  key: string;
  // Public URL of the artifact.
  url: string;
  // Stored object size in bytes.
  bytes: number;
  // The S3 object's Content-Encoding — how the bytes are stored at rest, NOT
  // necessarily what a client receives: an HTTP stack that honours
  // Content-Encoding (browser/RN fetch) hands back decompressed bytes, while a
  // straight-to-disk downloader (e.g. expo-file-system) typically writes the
  // raw gzip stream. Downloaders must sniff the result (gzip magic 0x1f 0x8b)
  // rather than trust this field for the local file's shape.
  contentEncoding: 'gzip' | 'identity';
  // ISO-8601 UTC build timestamp (the key's basename is this stamp with
  // colons/dots replaced by dashes).
  builtAt: string;
  // The offline-sync client schema version the artifact's SQLite DDL was built
  // at (LATEST_SCHEMA_VERSION). A client older than this must migrate the file
  // up (or refuse it) before serving reads from it.
  schemaVersion: number;
  tables: Record<SnapshotTableName, SnapshotTableStats>;
};

export type SnapshotManifest = {
  formatVersion: 1;
  // ISO-8601 UTC — when the run that produced this manifest finished.
  generatedAt: string;
  entries: SnapshotManifestEntry[];
};

export const SNAPSHOT_MANIFEST_FORMAT_VERSION = 1 as const;

const SNAPSHOT_TABLE_NAMES: readonly SnapshotTableName[] = ['board_climbs', 'board_climb_stats'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// layoutId / bytes / schemaVersion / rowCount are all integral by construction
// (a DB id, an object size, a migration version, a count) — a fractional value
// can only mean a corrupted or hand-edited manifest, so reject it outright.
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

// generatedAt / builtAt / watermarkUpdatedAt become resume watermarks and cache
// keys, so a corrupted manifest carrying a non-ISO string must be rejected here
// rather than stored and pulled-from later. Zulu-suffixed ISO-8601 with optional
// fractional seconds — the only shape toIso() ever emits.
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function isTableStats(value: unknown): value is SnapshotTableStats {
  if (!isRecord(value)) return false;
  return (
    isIsoUtcTimestamp(value.watermarkUpdatedAt) && isDecimalString(value.watermarkSyncSeq) && isInteger(value.rowCount)
  );
}

function isManifestEntry(value: unknown): value is SnapshotManifestEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.boardType !== 'string' ||
    !isInteger(value.layoutId) ||
    typeof value.key !== 'string' ||
    typeof value.url !== 'string' ||
    !isInteger(value.bytes) ||
    (value.contentEncoding !== 'gzip' && value.contentEncoding !== 'identity') ||
    !isIsoUtcTimestamp(value.builtAt) ||
    !isInteger(value.schemaVersion)
  ) {
    return false;
  }
  const tables = value.tables;
  if (!isRecord(tables)) return false;
  return SNAPSHOT_TABLE_NAMES.every((tableName) => isTableStats(tables[tableName]));
}

/**
 * Structurally validate a parsed-JSON value as a SnapshotManifest. Returns the
 * narrowed value or null — callers treat null as "no usable manifest" and fall
 * back to a from-scratch incremental pull rather than throwing.
 */
export function parseSnapshotManifest(value: unknown): SnapshotManifest | null {
  if (!isRecord(value)) return null;
  if (value.formatVersion !== SNAPSHOT_MANIFEST_FORMAT_VERSION) return null;
  if (!isIsoUtcTimestamp(value.generatedAt)) return null;
  if (!Array.isArray(value.entries)) return null;
  if (!value.entries.every(isManifestEntry)) return null;
  return value as SnapshotManifest;
}
