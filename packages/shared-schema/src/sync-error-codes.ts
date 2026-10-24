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
 * A warning, not a failure: the cycle succeeded, and only the playlist mirror
 * is paused, so neither account can overwrite or destroy the other's. It does
 * NOT mean the sends arrived. When the other account also owns the logbook,
 * the runner writes FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR instead (#6687).
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

/**
 * The sends on this board login already belong to another Boardsesh account,
 * so this account's sync skips them and its logbook stays empty (#6687). The
 * usual shape: the first account's link expired or was removed, which lets a
 * second account link the same board login, but every tick stays where it
 * first landed.
 *
 * A warning, not a failure: the cycle succeeded and the credential stays
 * `active`. It is a state, not a per-cycle event, so it clears on its own once
 * the other account no longer holds those sends.
 *
 * Wins over every circuits code. One column carries one code, and this is the
 * one that explains an empty logbook. Signing in to the other account (or
 * asking support) is also the answer for its playlists, so nothing is lost.
 * The copy says "some sends": new sends with no owner still import here.
 *
 * Sent over REST as-is, never folded onto DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR:
 * an app that predates this code shows its generic error line for it, which is
 * honest. The legacy circuits copy promised the sends were still arriving.
 */
export const FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR = 'duplicate-board-account-link:logbook';

/** Persistent ownership state for one credential's Aurora circuit playlists. */
export type CircuitPlaylistOwnershipConflictState = 'none' | 'foreign' | 'ambiguous';
export type CircuitPlaylistSyncErrorReason = Exclude<CircuitPlaylistOwnershipConflictState, 'none'>;

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
export function circuitPlaylistSyncWarningKind(
  syncError: string | null,
  syncErrorReason?: CircuitPlaylistSyncErrorReason,
): CircuitPlaylistSyncWarningKind | null {
  // `syncErrorReason` crosses a REST boundary. Only trust it alongside the
  // generic compatibility code that `circuitPlaylistSyncWireFields` emits;
  // precise stored codes remain authoritative even if a response is malformed.
  if (syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR && syncErrorReason) return syncErrorReason;
  if (syncError === FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'foreign';
  if (syncError === AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'ambiguous';
  if (syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR) return 'legacy';
  return null;
}

export type CircuitPlaylistSyncWireFields = {
  syncError: string | null;
  syncErrorReason?: CircuitPlaylistSyncErrorReason;
};

/**
 * Keep the long-standing generic code on the REST wire so older clients still
 * render their localised duplicate-account warning. Current clients receive a
 * separate reason field for the more precise foreign/ambiguous copy.
 */
export function circuitPlaylistSyncWireFields(syncError: string | null): CircuitPlaylistSyncWireFields {
  const warningKind = circuitPlaylistSyncWarningKind(syncError);
  if (warningKind === 'foreign' || warningKind === 'ambiguous') {
    return {
      syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
      syncErrorReason: warningKind,
    };
  }
  return { syncError };
}

/** Every warning a board card knows how to localise. */
export type BoardAccountSyncWarningKind = CircuitPlaylistSyncWarningKind | 'logbook';

/**
 * Decode a credential's `sync_error` into the warning a board card shows.
 * Unknown or free-text errors return null, so clients keep rendering them as a
 * real failure.
 */
export function boardAccountSyncWarningKind(
  syncError: string | null,
  syncErrorReason?: CircuitPlaylistSyncErrorReason,
): BoardAccountSyncWarningKind | null {
  if (syncError === FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR) return 'logbook';
  return circuitPlaylistSyncWarningKind(syncError, syncErrorReason);
}

/**
 * The success-path `sync_error` a runner stores. The logbook conflict wins over
 * any circuits code: the column holds one value, and "your sends are on another
 * account" is the one that explains an empty logbook.
 */
export function boardAccountSyncErrorCode(input: {
  logbookOwnedElsewhere: boolean;
  circuitsSyncError: string | null;
}): string | null {
  if (input.logbookOwnedElsewhere) return FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR;
  return input.circuitsSyncError;
}

/** Every `sync_error` value clients are expected to recognise and localise. */
export type SyncErrorCode =
  | typeof DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
  | typeof FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
  | typeof AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
  | typeof FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR;
