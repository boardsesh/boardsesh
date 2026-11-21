// Wire shapes of the sync pull GraphQL API. These mirror the SDL in
// `packages/shared-schema/src/schema.ts` (SyncCursorInput / SyncResult /
// SyncDeletionsResult) and the per-table contract in docs/data/sync-table-manifest.md.
// Deliberately hand-written rather than imported from @boardsesh/graphql: the
// generated types chain typecheck onto codegen and weaken `documents` to `any`.

export type SyncCursorInput = {
  updatedAt: string;
  syncSeq: string;
};

export type SyncCursor = {
  updatedAt: string;
  syncSeq: string;
};

export type SyncResult = {
  documents: Record<string, unknown>[];
  cursor: SyncCursor;
  hasMore: boolean;
};

export type SyncDeletionRecord = {
  tableName: string;
  recordId: string;
  deletedAt: string;
};

export type SyncDeletionsResult = {
  deletions: SyncDeletionRecord[];
  cursor: SyncCursor;
  hasMore: boolean;
};
