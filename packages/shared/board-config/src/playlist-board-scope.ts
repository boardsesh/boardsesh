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
 * The fallback is per-field on purpose: `boardType` and `layoutId` are
 * independently nullable on the GraphQL `Climb`, and taking the host's layout
 * when only the board is known is still narrower than ignoring the climb
 * entirely.
 */
export function resolveClimbBoardScope(
  climb: { boardType?: string | null; layoutId?: number | null },
  fallback: { boardType: string; layoutId: number },
): { boardType: string; layoutId: number } {
  return {
    boardType: climb.boardType ?? fallback.boardType,
    layoutId: climb.layoutId ?? fallback.layoutId,
  };
}
