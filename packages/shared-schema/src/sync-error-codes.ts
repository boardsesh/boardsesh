/**
 * Machine-readable values for `aurora_credentials.sync_error`.
 *
 * The column started life carrying raw English sentences written by the sync
 * daemons, which every client could only render verbatim — so an `es` or `fr`
 * user got English on their board card. A code lets the daemon say WHAT
 * happened and leaves the wording to whichever surface is showing the card.
 *
 * Clients must keep rendering an unrecognised `sync_error` as-is. The legacy
 * free-text values (rejected refresh tokens, upstream outages) are still
 * written by other paths, and showing them beats swallowing them.
 */

/**
 * Circuits → playlists sync is refused because a second Boardsesh account is
 * connected to the same board login, and the playlists carrying these upstream
 * circuit ids are owned there (#3526).
 *
 * A warning, not a failure: the cycle succeeded and everything else on the
 * credential — sends, bids, ratings — is still syncing. Only the playlist
 * mirror is paused, so neither account can overwrite or destroy the other's.
 */
export const DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR = 'duplicate-board-account-link:circuits';

/**
 * This account cannot claim the circuit playlists because another Boardsesh
 * user is their sole owner.
 */
export const FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR = 'duplicate-board-account-link:circuits:foreign';

/**
 * The syncing user and at least one other Boardsesh user both hold owner edges
 * on a circuit playlist. Neither side may write until the legacy cross-link is
 * resolved.
 */
export const AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR = 'duplicate-board-account-link:circuits:ambiguous';

/** Persistent ownership state for one credential's Aurora circuit playlists. */
export type CircuitPlaylistOwnershipConflictState = 'none' | 'foreign' | 'ambiguous';

/** The warning variants mobile and web know how to localise. */
export type CircuitPlaylistSyncWarningKind = Exclude<CircuitPlaylistOwnershipConflictState, 'none'> | 'legacy';

/** Convert a fresh ownership-state read to the code persisted by the runner. */
export function circuitPlaylistConflictSyncError(
  state: CircuitPlaylistOwnershipConflictState,
): typeof FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR | typeof AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR | null {
  if (state === 'foreign') return FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
  if (state === 'ambiguous') return AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
  return null;
}

/**
 * Decode both current codes and the pre-#3950 generic value. Unknown/free-text
 * errors deliberately return null so clients continue rendering them verbatim.
 */
export function circuitPlaylistSyncWarningKind(syncError: string | null): CircuitPlaylistSyncWarningKind | null {
  if (syncError === FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'foreign';
  if (syncError === AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'ambiguous';
  if (syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'legacy';
  return null;
}

/** Every `sync_error` value clients are expected to recognise and localise. */
export type SyncErrorCode =
  | typeof DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
  | typeof FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
  | typeof AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
