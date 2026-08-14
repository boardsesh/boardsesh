// Dev-only write-lock holder for the offline database (issue #4315).
//
// Opens a SECOND connection to `boardsesh.db` and sits on a real write lock for
// N milliseconds. Any hold longer than the app's `busy_timeout` makes every
// other connection's write throw the GENUINE platform lock error — which is the
// only way to prove on a device that `isDatabaseLockedError` still matches what
// Android and iOS actually emit (Android prints a raw U+0005 control byte where
// the result-code digit belongs; iOS prints `Error code 5:`). The fault injector
// next door emits the strings we BELIEVE those platforms produce, so it cannot
// substitute for this check.
//
// Reachable only from the tester/dev-gated "Offline writes" screen. Nothing here
// runs at import time.

import { openDatabaseAsync } from 'expo-sqlite';
import { DATABASE_NAME } from '../../db';

/** Key of the throwaway row the hold writes; never read by anything else. */
const LOCK_HOLDER_META_KEY = 'dev:lock-holder';

let holdingUntil = 0;

export function isHoldingWriteLock(): boolean {
  return Date.now() < holdingUntil;
}

/**
 * Hold a real write lock on the offline database for `durationMs`.
 *
 * `busy_timeout = 0` on the holding connection so it never itself waits, then a
 * throwaway write against `sync_meta` — a real write lock, not the deferred
 * `BEGIN` that `withExclusiveTransactionAsync` opens, which takes no lock until
 * its first statement. The row is deleted before the transaction commits, so the
 * database is byte-identical afterwards.
 *
 * Resolves when the lock is released. Rejects only if the connection itself
 * fails; the caller shows the message.
 */
export async function holdWriteLock(durationMs: number): Promise<void> {
  const connection = await openDatabaseAsync(DATABASE_NAME);
  holdingUntil = Date.now() + durationMs;
  try {
    await connection.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync('PRAGMA busy_timeout = 0');
      await txn.runAsync(`INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`, [
        LOCK_HOLDER_META_KEY,
        new Date().toISOString(),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
      await txn.runAsync(`DELETE FROM sync_meta WHERE key = ?`, [LOCK_HOLDER_META_KEY]);
    });
  } finally {
    holdingUntil = 0;
    await connection.closeAsync();
  }
}
