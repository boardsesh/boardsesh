/**
 * Ownership arbitration for playlists that carry an UPSTREAM circuit id
 * (`playlists.kilter_id` / `playlists.aurora_id`).
 *
 * Both columns are backed by a GLOBAL unique index
 * (`playlists_kilter_id_idx`, `playlists_aurora_id_idx`) — a given upstream
 * circuit uuid lives on at most one playlist row table-wide, with no user
 * scoping. That is fine while one upstream account maps to one Boardsesh
 * user, and actively dangerous once it doesn't: an `ON CONFLICT (kilter_id)
 * DO UPDATE` run for user B lands on user A's row, and the ownership insert
 * that follows hands B an `owner` edge on A's playlist (issue #3526).
 *
 * The rule these helpers encode:
 *
 *   A playlist row carrying an upstream circuit id has exactly ONE Boardsesh
 *   sync owner — the user whose sync created it. A sync running for any other
 *   Boardsesh user that resolves the same upstream id must not update the row,
 *   must not touch its playlist_climbs, must not insert an ownership row, and
 *   must not delete it. It skips and logs, exactly as the logs paths already do
 *   for a foreign `kilter_id` / `aurora_id`
 *   (kilter-sync applyLogs `foreignKilterIds`, aurora-sync `foreignAuroraIds`).
 *
 * Deliberately pure and dependency-free so `@boardsesh/sync-runtime` stays a
 * drizzle-free package: each sync package runs its own owner query and feeds
 * the resulting user-id list in here.
 */

/**
 * What a sync running for one user is allowed to do with a playlist that
 * carries the upstream circuit id it is currently applying.
 *
 * - `adopt`     — nobody owns it: either no playlist row exists yet (fresh
 *                 insert) or the row is an orphan with no `owner` edge. Safe to
 *                 write and to claim.
 * - `own`       — this user is the sole owner. The ordinary re-sync path.
 * - `foreign`   — someone else owns it and this user does not. The
 *                 duplicate-account shape. Skip and log.
 * - `ambiguous` — more than one owner, this user among them. Already
 *                 cross-linked (the 44 legacy prod rows). Refuse to write in
 *                 EITHER direction so neither co-owner can overwrite or destroy
 *                 the shared row while a human resolves it (issue #3541).
 */
export type UpstreamPlaylistWriteDecision = 'adopt' | 'own' | 'foreign' | 'ambiguous';

/**
 * Decide what `syncingUserId` may do with a playlist whose current `owner`
 * edges belong to `ownerUserIds`.
 *
 * `ownerUserIds` must be the user ids of the playlist's `role = 'owner'` rows.
 * Pass an empty list when no playlist row matched the upstream id. `editor` /
 * `viewer` rows are deliberately NOT included by callers: a collaborator must
 * never block the owner's sync.
 */
export function resolveUpstreamPlaylistWrite(
  ownerUserIds: readonly string[],
  syncingUserId: string,
): UpstreamPlaylistWriteDecision {
  // Distinct: a caller joining playlists → playlist_ownership can hand us the
  // same user id twice if the join fans out. One owner repeated is still one
  // owner, and must not read as `ambiguous`.
  const distinctOwners = new Set(ownerUserIds);
  if (distinctOwners.size === 0) return 'adopt';
  const isOwner = distinctOwners.has(syncingUserId);
  if (distinctOwners.size === 1) return isOwner ? 'own' : 'foreign';
  return isOwner ? 'ambiguous' : 'foreign';
}

/** True when the decision permits writing to (or claiming) the playlist. */
export function canWriteUpstreamPlaylist(decision: UpstreamPlaylistWriteDecision): boolean {
  return decision === 'adopt' || decision === 'own';
}

/**
 * Log line for a refused write. Shaped like the existing foreign-id lines in
 * both logs paths so an operator greps one phrase across all four surfaces.
 */
export function upstreamPlaylistSkipLogLine(input: {
  /** `kilter-sync` | `aurora-sync` | `aurora-import` — matches the package's other log lines. */
  syncTag: string;
  /** `kilter_id` | `aurora_id` — the column the collision happened on. */
  upstreamIdColumn: string;
  upstreamId: string;
  syncingUserId: string;
  decision: UpstreamPlaylistWriteDecision;
}): string {
  const cause =
    input.decision === 'ambiguous'
      ? 'playlist already has two owners — refusing to write until the duplicate accounts are resolved'
      : 'playlist already owned by a different Boardsesh user';
  return `[${input.syncTag}] ${input.upstreamIdColumn} ${input.upstreamId}: ${cause} — skipping for user ${input.syncingUserId} (duplicate board account link)`;
}
