// Re-opening `boardsesh.db` after its native handle died under us (#5410).
//
// THE TRAP. A plain `openDatabaseAsync(DATABASE_NAME)` gives you back the SAME
// DEAD INSTANCE. Nothing ever closed it — the binding was destroyed by a collected
// wrapper's releaser, not by `closeAsync` — so its refcount never reached zero,
// `removeCachedDatabase` never evicted it, and `cachedDatabases` still holds it for
// the next lookup to find.
//
// THE ESCAPE. Both platforms' constructors short-circuit the cache lookup on the
// REQUESTING options:
//
//   findCachedDatabase { it.databasePath == databasePath && it.openOptions == options
//                        && !options.useNewConnection }
//
// so `useNewConnection: true` can never be served from the cache. It cannot be
// poisoned later either: `OpenDatabaseOptions` is a data class, so a later
// default-options open can't match this entry any more than this one could match
// the dead one. We get a genuinely fresh `sqlite3*`.
//
// WHAT IT COSTS. One more connection on a WAL file, which the app already pays for
// on every `withExclusiveTransactionAsync` and every pull write. The init ladder
// re-runs `configureMainConnection` on it, so it gets the same WAL mode and
// `busy_timeout` as the connection it replaces. In development it is skipped by
// `registerDatabaseForDevToolsAsync`, so it will not show in the devtools database
// list — the only visible difference.
//
// REJECTED: draining the refcount with repeated `closeAsync` to evict the dead
// entry. It does evict (the removal precedes the close), but JS cannot read the
// refcount, so the stopping rule would be "call it until it throws" — and the throw
// is indistinguishable from the bug we are recovering from.

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { DATABASE_NAME } from './database-name';

/** A fresh native connection to the app database, bypassing the poisoned cache. */
export function openReplacementDatabase(): Promise<SQLiteDatabase> {
  return openDatabaseAsync(DATABASE_NAME, { useNewConnection: true });
}
