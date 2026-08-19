/**
 * ⚠️ READ THIS BEFORE ADDING ANOTHER OFFLINE-REPLAYABLE MUTATION ⚠️
 *
 * `updatePlaylist` is the ONE queued mutation that must never be auto-merged.
 *
 * Every other mutation the offline outbox replays is either idempotent (a tick
 * upsert keyed by uuid, a favourite toggle, a playlist create keyed by a
 * client-generated uuid) or commutative (adding, removing and reordering climbs
 * inside a playlist — two devices doing both still converge on a sane list).
 * Those can be replayed blind: the worst case is a redundant write.
 *
 * A playlist rename cannot. Two devices editing the same name produce two
 * different intents, and picking one silently destroys the other. So the server
 * refuses the write and hands the client both versions to choose between, using
 * the code and extension shape below.
 *
 * If you add a mutation with the same property — a whole-record edit where the
 * loser's intent is unrecoverable — REUSE `PLAYLIST_UPDATE_CONFLICT_CODE`'s
 * shape (a code plus the server's current values) rather than inventing a new
 * one, and give it a typed reader next to `readPlaylistUpdateConflict` in
 * `@boardsesh/graphql/errors`. Clients already know how to prompt on this shape;
 * a second shape means a second prompt to build and a second thing to forget.
 *
 * A conflict resolves to no HTTP/GraphQL numeric status, so the outbox's
 * `isRetryable` returns false and the row dead-letters for the UI to resolve
 * instead of burning its retry budget.
 */

/**
 * The server refused a playlist metadata edit because the stored record moved on
 * from the snapshot the client based its edit on, and the two disagree about at
 * least one field being written.
 *
 * Only raised when the client opts in by sending `UpdatePlaylistInput.basedOn`.
 * Omit it and the mutation stays blind last-write-wins, which is what pre-#1934
 * clients (and web) do.
 */
export const PLAYLIST_UPDATE_CONFLICT_CODE = 'PLAYLIST_UPDATE_CONFLICT';

/**
 * What the server attaches to a `PLAYLIST_UPDATE_CONFLICT` error: the playlist's
 * current stored values, so the client can name both versions in the prompt
 * without a refetch, and rebuild `basedOn` for a "keep mine" retry.
 */
export type PlaylistUpdateConflictExtensions = {
  code: typeof PLAYLIST_UPDATE_CONFLICT_CODE;
  /** The playlist the edit targeted (its uuid, the client-facing id). */
  playlistUuid: string;
  /** The stored `updated_at`, ISO 8601 — the token a retry must be based on. */
  serverUpdatedAt: string;
  serverName: string;
  serverDescription: string | null;
  serverIsPublic: boolean;
  serverColor: string | null;
  serverIcon: string | null;
};
