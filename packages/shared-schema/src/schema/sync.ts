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
  Which half of a board's climbs a per-board pull returns. The two halves are
  disjoint, and together they are exactly the rows the same pull returns with no
  audience at all.
  """
  enum SyncAudience {
    """
    Climbs with no Boardsesh owner, not Boardsesh-authored, and with no privacy
    policy row, plus their stats and grades. The same rows for every viewer, and
    the same rows the offline snapshot artifact carries. Selected by ownership,
    not by visibility: an unowned draft, unlisted or hidden climb is included,
    as it is when no audience is given. Always empty for spray walls.
    """
    REFERENCE
    """
    Climbs with a Boardsesh author that the caller may see, plus their stats and
    grades. Authorized per viewer. Stats rows carry no first-ascent name or date.
    For spray walls this is every climb the caller may see on the wall.
    """
    PROTECTED
  }

  "Canonical saved-climb documents from one snapshot, without changing a pull cursor."
  type SyncClimbDocuments {
    "Authenticated account owning the client mirror, independent of the setter."
    viewerId: ID!
    climb: JSON!
    stats: [JSON!]!
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
