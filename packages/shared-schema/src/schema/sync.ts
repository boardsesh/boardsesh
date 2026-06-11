export const syncTypeDefs = /* GraphQL */ `
  # ============================================
  # Offline Sync Types (Phase 2)
  # ============================================
  #
  # The sync pull resolvers return opaque snake_case JSON documents (the keys are
  # the mobile SQLite column names — see docs/sync-table-manifest.md). The cursor
  # is a composite (updatedAt, syncSeq) so timestamp collisions during Aurora bulk
  # updates never skip rows. Timestamps are ISO-8601 String, never a DateTime
  # scalar (the codebase has none).

  """
  Composite sync cursor sent by the client to resume a pull. Both fields come
  from a previous SyncResult.cursor. Omit (null) on the first pull to start from
  the beginning.
  """
  input SyncCursorInput {
    "Last seen updated_at (ISO 8601). Null on first pull."
    updatedAt: String
    "Last seen sequence component, stringified bigint. Null on first pull."
    syncSeq: String
  }

  """
  Composite sync cursor returned by a pull. Feed it back as SyncCursorInput on
  the next page.
  """
  type SyncCursor {
    "updated_at of the last row in this page (ISO 8601)."
    updatedAt: String!
    "Sequence component of the last row, stringified bigint."
    syncSeq: String!
  }

  """
  One page of synced rows. \`documents\` are snake_case JSON objects whose keys
  match the mobile local columns.
  """
  type SyncResult {
    "Rows in this page as snake_case JSON documents."
    documents: [JSON!]!
    "Cursor to resume from. Pass back as SyncCursorInput."
    cursor: SyncCursor!
    "Whether more rows remain after this page."
    hasMore: Boolean!
  }

  """
  A single hard-deleted record the client should remove locally.
  """
  type SyncDeletion {
    "Postgres table the row was deleted from."
    tableName: String!
    "Natural-key encoding of the deleted row (see docs/sync-table-manifest.md)."
    recordId: String!
    "When the row was deleted (ISO 8601)."
    deletedAt: String!
  }

  """
  One page of deletions for the client to apply.
  """
  type SyncDeletionsResult {
    "Deletions in this page."
    deletions: [SyncDeletion!]!
    "Cursor to resume from. Pass back as SyncCursorInput."
    cursor: SyncCursor!
    "Whether more deletions remain after this page."
    hasMore: Boolean!
  }
`;
