// Offline sync types (Phase 2). Mirror the SDL in schema/sync.ts and the
// generated resolver types. Documents are opaque snake_case JSON objects (keys =
// mobile local columns — see docs/sync-table-manifest.md), so they are typed as
// `unknown` here. Timestamps are ISO-8601 strings, never a DateTime scalar.

/**
 * Which half of a board's climbs a per-board pull returns. `REFERENCE` is the
 * climbs with no Boardsesh owner, author flag or privacy policy row (the
 * snapshot artifact's row set, the same for every viewer); `PROTECTED` is the
 * Boardsesh-authored climbs the caller may see. Absent means both in one stream.
 */
export type SyncAudience = 'REFERENCE' | 'PROTECTED';

export type SyncCursorInput = {
  updatedAt?: string | null;
  syncSeq?: string | null;
};

export type SyncCursor = {
  updatedAt: string;
  syncSeq: string;
};

export type SyncResult = {
  documents: unknown[];
  cursor: SyncCursor;
  hasMore: boolean;
};

export type SyncDeletion = {
  tableName: string;
  recordId: string;
  deletedAt: string;
};

export type SyncDeletionsResult = {
  deletions: SyncDeletion[];
  cursor: SyncCursor;
  hasMore: boolean;
};

export type SyncClimbDocuments = {
  viewerId: string;
  /** Canonical snake_case column sets are defined in the saved-climb resolver. */
  climb: unknown;
  stats: unknown[];
};
