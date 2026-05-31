// Offline sync types (Phase 2). Mirror the SDL in schema/sync.ts and the
// generated resolver types. Documents are opaque snake_case JSON objects (keys =
// mobile local columns — see docs/sync-table-manifest.md), so they are typed as
// `unknown` here. Timestamps are ISO-8601 strings, never a DateTime scalar.

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
