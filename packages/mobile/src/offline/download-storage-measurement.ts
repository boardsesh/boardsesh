import { Directory, File, Paths } from 'expo-file-system';
import { DATABASE_NAME } from '../db/database-name';
import { SNAPSHOT_DIR_NAME } from './snapshot-paths';

// Matches spray-photo-store.ts. Keep this leaf independent of the photo store's
// privacy lifecycle and of the database connection it helps measure.
const SPRAY_PHOTO_DIRECTORY = 'spray-wall-photos';

export type OfflineDownloadStorageMeasurement = {
  databaseBytes: number;
  artifactBytes: number;
  photoBytes: number;
  totalBytes: number;
};

function measureEntryBytes(entry: File | Directory): number | null {
  // File.size returns 0 on native read errors. info() validates permission and
  // throws instead, so an unreadable existing file cannot become a fake zero.
  const metadata = entry.info();
  if (!metadata.exists) return 0;
  const bytes = metadata.size;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * A read-only filesystem sample, not a continuous peak or a per-board estimate.
 * Counts SQLite's retained pages and sidecars, cached snapshots, and durable wall
 * photos. A missing path contributes zero; an unreadable path makes the whole
 * sample unknown. Call at lifecycle boundaries, never from a render loop.
 */
export function measureOfflineDownloadStorage(): OfflineDownloadStorageMeasurement | null {
  try {
    const sqliteDirectory = new Directory(Paths.document, 'SQLite');
    let databaseBytes = 0;
    for (const fileName of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
      const bytes = measureEntryBytes(new File(sqliteDirectory, fileName));
      if (bytes === null) return null;
      databaseBytes += bytes;
    }
    const artifactBytes = measureEntryBytes(new Directory(Paths.cache, SNAPSHOT_DIR_NAME));
    const photoBytes = measureEntryBytes(new Directory(Paths.document, SPRAY_PHOTO_DIRECTORY));
    if (artifactBytes === null || photoBytes === null) return null;
    const totalBytes = databaseBytes + artifactBytes + photoBytes;
    if (!Number.isSafeInteger(totalBytes)) return null;
    return { databaseBytes, artifactBytes, photoBytes, totalBytes };
  } catch {
    return null;
  }
}
