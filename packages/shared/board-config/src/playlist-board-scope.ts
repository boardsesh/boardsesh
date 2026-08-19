/**
 * The single definition of "does this climb belong in this playlist".
 *
 * A playlist is scoped to a board and only *optionally* to a layout (a null
 * `layoutId` is how Aurora- and Kilter-synced circuits arrive, and those are
 * valid targets on every layout of their own board). A climb belongs to exactly
 * one board + layout.
 *
 * This rule lives here because two sides have to agree on it and previously did
 * not: the backend `addClimbToPlaylist` guard (#4015) enforced it against the
 * climb's own `board_climbs` row, while the mobile picker filtered the offered
 * playlists against whatever board config the host surface happened to be
 * rendering on. Those keys coincide on most surfaces and diverge on a
 * cross-board preview, where the picker offered a playlist the server then
 * rejected outright. One exported function, imported by both.
 */

export type PlaylistBoardScope = {
  boardType: string;
  /** Null = the playlist is board-wide and takes any layout of its own board. */
  layoutId: number | null;
};

export type ClimbBoardScope = {
  boardType: string;
  /**
   * Null = the caller does not know the climb's layout. Only clients hit this;
   * `board_climbs.layout_id` is NOT NULL, so the server always has a real value.
   */
  layoutId: number | null;
};

/**
 * True when `climb` may be added to a playlist with `playlist`'s board scope.
 *
 * Unknown beats rejection on both sides: a board-wide playlist accepts any
 * layout, and a climb whose layout the caller could not resolve is never
 * rejected on a guess (the server, which always knows the layout, still has the
 * final say).
 */
export function climbFitsPlaylistBoard(climb: ClimbBoardScope, playlist: PlaylistBoardScope): boolean {
  if (climb.boardType !== playlist.boardType) return false;
  if (playlist.layoutId === null) return true;
  if (climb.layoutId === null) return true;
  return climb.layoutId === playlist.layoutId;
}

/**
 * The board scope a client should judge playlists against for a given climb.
 *
 * Prefers what the climb itself carries (`boardType` / `layoutId`, populated in
 * multi-board contexts — logbook, profile climbs, playlist detail, the play
 * drawer's cross-board preview) and falls back to the surface's own board
 * config for payloads that don't, which is every single-board surface where the
 * two are the same value anyway.
 *
 * **A layout id is only ever paired with the board it was resolved in.** Layout
 * ids are namespaced per board (`board_layouts` PK is `(board_type, id)`), so
 * pairing the climb's board with the host's layout describes a board nobody
 * has: a filter that matches none of the climber's own playlists, a membership
 * query with no answer, and — worst — an inline create that writes a playlist
 * row the server's guard can never accept. So the two fields resolve together,
 * never one from each side:
 *
 * - the climb names no board, or names the host's, so it *is* on the host
 *   board: the host's layout id is a legitimate stand-in for a missing one;
 * - the climb names a different board: the host's layout id belongs to another
 *   namespace, so a missing layout stays `null` — unknown, not guessed.
 *   `climbFitsPlaylistBoard` then declines to reject on the layout and leaves
 *   the last word to the server, which always knows the real one.
 *
 * `boardType` is what tells those apart: it is documented as "populated in
 * multi-board contexts", so a payload that omits it came off a surface whose
 * own board is the climb's.
 *
 * A `null` layout is a real outcome here, not a type formality — callers that
 * need a concrete layout id (creating a playlist, querying memberships) have to
 * handle "unknown" rather than substitute one.
 */
export function resolveClimbBoardScope(
  climb: { boardType?: string | null; layoutId?: number | null },
  fallback: { boardType: string; layoutId: number },
): { boardType: string; layoutId: number | null } {
  const boardType = climb.boardType ?? fallback.boardType;
  if (boardType !== fallback.boardType) return { boardType, layoutId: climb.layoutId ?? null };
  return { boardType, layoutId: climb.layoutId ?? fallback.layoutId };
}
