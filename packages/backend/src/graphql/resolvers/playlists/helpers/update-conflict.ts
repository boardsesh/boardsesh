/**
 * Compare-and-swap rule for `updatePlaylist` (#1934).
 *
 * A playlist rename is the one offline-replayable mutation that can't be
 * auto-merged (see the doc block on PLAYLIST_UPDATE_CONFLICT_CODE in
 * @boardsesh/shared-schema), so the server has to be able to say "this changed
 * somewhere else" instead of quietly keeping whichever write landed last.
 *
 * Pure and dependency-free so the rule can be unit-tested without a database.
 */

/** The metadata fields an edit can carry. Shared by stored / incoming / based-on. */
export type PlaylistMetadataFields = {
  name?: string | null;
  description?: string | null;
  isPublic?: boolean | null;
  color?: string | null;
  icon?: string | null;
};

export type PlaylistUpdateConflictArgs = {
  /** The row as it is in the database right now. */
  stored: PlaylistMetadataFields & { updatedAt: Date };
  /** The fields this edit wants to write (absent = leave unchanged). */
  incoming: PlaylistMetadataFields;
  /** What the client last saw, or undefined for blind last-write-wins. */
  basedOn?: (PlaylistMetadataFields & { updatedAt: string }) | null;
};

const TEXT_FIELDS = ['name', 'description', 'color', 'icon'] as const;

/**
 * Collapse the '' clear signal and NULL to one value, mirroring the resolver's
 * `|| null` write path — a description cleared to '' is stored as NULL, so a
 * client that still holds the '' it typed must compare equal to the NULL on disk.
 *
 * `undefined` is preserved: it means "this field wasn't sent", which is a
 * different question from "this field is empty".
 */
export function normalizePlaylistText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return value;
}

function valuesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  // undefined never matches: an absent based-on field can't prove the client saw
  // the stored value, and an absent incoming field isn't being written at all.
  if (left === undefined || right === undefined) return false;
  return left === right;
}

/**
 * Whether this edit must be refused as a conflict.
 *
 * Three stages, in order:
 *
 * 1. No `basedOn` → never a conflict. Pre-#1934 clients and web send no
 *    snapshot and keep today's blind last-write-wins behaviour.
 *
 * 2. The stored row is no newer than the snapshot → apply. This is the fast
 *    path: nothing has happened since the client read the playlist.
 *
 * 3. The stored row IS newer → conflict only when some field this edit writes
 *    disagrees with BOTH the stored value and the value the client saw.
 *
 * Stage 3 is what makes the check usable at all. `addClimbToPlaylist`,
 * `removeClimbFromPlaylist` and `reorderPlaylistClimb` all bump
 * `playlists.updated_at` (that column drives library ordering, so they can't
 * stop), which means a bare timestamp comparison would report a conflict every
 * time someone adds a climb — including when the same device's own outbox
 * drains an add ahead of the rename. Comparing the actual values keeps the
 * timestamp as a cheap gate and lets the field check decide.
 *
 * It also makes an ambiguous re-send a no-op success: if the rename already
 * landed, the incoming values equal the stored ones, so there is nothing to
 * disagree about.
 */
export function detectPlaylistUpdateConflict({ stored, incoming, basedOn }: PlaylistUpdateConflictArgs): boolean {
  // Stage 1 — opt-in only.
  if (!basedOn) return false;

  // Stage 2 — nothing moved. `updated_at` is a `timestamp` without time zone and
  // round-trips Date → toISOString → parse at millisecond precision; any sub-ms
  // drift only pushes the decision into stage 3, where identical values apply.
  const basedOnUpdatedAt = Date.parse(basedOn.updatedAt);
  if (!Number.isNaN(basedOnUpdatedAt) && stored.updatedAt.getTime() <= basedOnUpdatedAt) return false;

  // Stage 3 — the row moved, so check whether it moved in a way this edit cares about.
  for (const field of TEXT_FIELDS) {
    const incomingValue = normalizePlaylistText(incoming[field]);
    if (incomingValue === undefined) continue; // not being written
    const storedValue = normalizePlaylistText(stored[field]);
    if (valuesMatch(storedValue, incomingValue)) continue; // already what we want
    if (valuesMatch(storedValue, normalizePlaylistText(basedOn[field]))) continue; // nobody else touched it
    return true;
  }

  // isPublic is non-null on the server, so a null in the snapshot means the
  // client had no value for it — the conservative case, same as an absent field.
  if (incoming.isPublic !== undefined && incoming.isPublic !== null) {
    const storedIsPublic = stored.isPublic ?? false;
    const sawIsPublic = basedOn.isPublic ?? undefined;
    const clientSawStoredValue = sawIsPublic !== undefined && sawIsPublic === storedIsPublic;
    if (storedIsPublic !== incoming.isPublic && !clientSawStoredValue) return true;
  }

  return false;
}
