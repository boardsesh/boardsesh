// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

/** Every `sync_error` value clients are expected to recognise and localise. */
export type SyncErrorCode = typeof DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
