// What offline mode occupies on this device, for the Manage Storage screen.
//
// The engine (@boardsesh/offline-sync) owns everything expressible in SQL — the
// per-scope row counts and the byte apportionment (getScopeUsage), and the freelist
// arithmetic (measureReclaimableBytes). What's left here is the platform I/O it
// can't do: reading the actual file sizes off disk.

import { Directory, File, Paths } from 'expo-file-system';
import { DATABASE_NAME } from './connection';

/**
 * Real bytes on disk for the offline database, including its WAL and shared-memory
 * sidecars.
 *
 * This is deliberately a filesystem stat rather than `PRAGMA page_count * page_size`:
 * the pragma reports only the main file's logical size, missing the `-wal` entirely
 * — which after a big catalog pull can itself be hundreds of MB. A stat is the same
 * number the OS storage screen shows, which is the number the user is actually
 * trying to make smaller. It counts freelist pages, correctly: space on the freelist
 * is still space the OS can't have back until a VACUUM.
 *
 * expo-sqlite keeps databases in `<documents>/SQLite/`. The sidecars are absent
 * outside WAL mode and after a truncating checkpoint, so a missing file is normal
 * and contributes zero.
 */
export function measureDatabaseBytes(): number {
  const sqliteDirectory = new Directory(Paths.document, 'SQLite');
  let total = 0;
  for (const name of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
    const file = new File(sqliteDirectory, name);
    if (!file.exists) continue;
    total += file.size ?? 0;
  }
  return total;
}

/**
 * Free space on the device, or null when the platform won't say.
 *
 * `Paths.availableDiskSpace` is a synchronous getter (not a promise) and it throws on
 * some Android volumes, so callers get null rather than a fabricated `0 B free` —
 * which would read as "your phone is full" on a screen specifically about disk space.
 * Call this from an async data path, never during render.
 */
export function measureFreeDiskSpace(): number | null {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return null;
  }
}
