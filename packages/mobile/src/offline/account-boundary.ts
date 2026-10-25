// What the two local-data boundaries do when one account's data leaves the phone
// (#6545, #6563). The sign-out cleanup (`runSignedOutCleanup` in auth-provider)
// and the owner-stamp recovery (`OfflineSyncBridge`) both reset the same
// per-account offline settings through `resetOfflineAccountSettings`, so the two
// paths cannot drift apart again.

import type { SQLiteDatabase } from 'expo-sqlite';
import { beginGlobalPurge } from '@boardsesh/offline-sync';
import { clearUserData } from '../db';
import { clearStoredSprayPhotos } from '../lib/spray/spray-photo-store';
import { clearOfflineBoards, clearOwnedSprayWallPins, setSetting } from '../settings';
import { resetSyncStatus } from '../sync/sync-status';
import { forgetAbandonedDownloads } from './abandoned-download-terminals';

/**
 * Forget which boards this account downloads, what they are called, and when it
 * last synced. These are settings, not data: the downloaded catalogue rows and
 * their checkpoints are left alone, so the next account that enables the same
 * board resumes it instead of downloading it again.
 */
export function resetOfflineAccountSettings(): void {
  // The "downloaded boards" list. Left behind, the next account inherits the
  // previous one's offline selection and the scheduler keeps syncing it.
  setSetting('syncEnabledBoards', []);
  // "Last synced 5 minutes ago" belonged to the account that left.
  resetSyncStatus();
  // The board snapshots the offline picker replays. They carry board NAMES, so a
  // missed clear shows one climber's walls in the next climber's picker.
  clearOfflineBoards();
}

/**
 * The owner-stamp recovery: the half of a sign-out that never ran. The database
 * names another account, because the sign-out wipe did not run or did not
 * finish: a session that expired while the app was closed, a keychain read that
 * failed, a locked database (#4314), a crash mid-sign-out, or a restored backup.
 *
 * Does what the forced sign-outs do to local data. Downloaded catalogue rows and
 * board checkpoints stay (#6545).
 */
export async function wipePreviousAccountLocalData(db: SQLiteDatabase): Promise<void> {
  // First, as every other wipe path does (sign-out uses setSigningOut, a board
  // removal uses beginScopePurge). Since #6824 nothing should be mid-cycle here:
  // the bridge starts the scheduler only after this wipe and the new stamp, and
  // every pull requires a database stamped for its viewer. The bump stays as the
  // backstop: a page that was on the wire when clearUserData ran would land AFTER
  // the wipe, resurrecting rows with a checkpoint past them, which the strict `>`
  // delta pull never revisits and `user_data_complete` would then vouch for.
  // Bumping the epoch makes syncTable's post-await re-check discard that page.
  // GLOBAL, unlike a board removal: clearUserData DELETEs every user table plus
  // deleteUserCheckpoints, so there is nothing scope-shaped to narrow it to.
  beginGlobalPurge();
  // The previous account's unfinished downloads, closed without an event, and
  // BEFORE the enabled list is emptied: see `sweepDelistedDownloadTerminals`.
  await forgetAbandonedDownloads(db);
  // Before the row wipe's await. No sync cycle can start during this wipe or the
  // forget await above: the bridge holds the scheduler until the owner claim,
  // which lands after this wipe and the new stamp, and an ad-hoc pull refuses a
  // database not yet stamped for its viewer (#6824, the follow-up #6563 left).
  resetOfflineAccountSettings();
  await clearUserData(db);
  // The rows named a photograph each, and this recovery exists precisely because
  // the sign-out that should have run did not (#5448). Wiping the rows and leaving
  // the files would keep the other account's wall decodable with nothing on disk
  // left to say whose it was.
  clearStoredSprayPhotos();
  // Which owned spray walls were pinned offline, and for whom. Last, after the
  // rows are gone. `OwnedSprayWallsOfflinePin` does not wait for the owner check,
  // so on a contended launch it can pin the signed-in account's own walls before
  // this wipe and record them. The reset above then empties the list, and a
  // recorded wall is never pinned again. Clearing the record is itself a
  // settings write, which re-runs the pin, and the pin turns those walls back on.
  clearOwnedSprayWallPins();
}
