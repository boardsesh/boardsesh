import { Directory, File } from 'expo-file-system';
import { deserializeDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import {
  exportLocalProfileBackup,
  restoreLocalProfileBackup,
  type LocalProfileBackupCounts,
} from './local-profile-backup-core';

export type LocalProfileBackupResult = LocalProfileBackupCounts & {
  fileName: string;
  uri: string;
};

function backupFileName(createdAt: Date): string {
  return `boardsesh-local-${createdAt
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z')}.sqlite`;
}

const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;

export function isFilePickerCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.code === 'ERR_PICKER_CANCELLED' ||
    candidate.code === 'ERR_FILE_PICKING_CANCELLED' ||
    candidate.name === 'PickerCancelledException' ||
    candidate.name === 'FilePickingCancelledException'
  );
}

/** Opens the native provider picker, then writes a visible personal-only SQLite backup. */
export async function createLocalProfileBackupFile(source: SQLiteDatabase): Promise<LocalProfileBackupResult | null> {
  let destinationDirectory: Directory;
  try {
    destinationDirectory = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (isFilePickerCancellation(error)) return null;
    throw error;
  }
  const createdAt = new Date();
  const destination = await openDatabaseAsync(':memory:', { useNewConnection: true });
  try {
    const counts = await exportLocalProfileBackup(source, destination, createdAt.toISOString());
    const serialized = await destination.serializeAsync();
    const fileName = backupFileName(createdAt);
    // Android's Storage Access Framework exposes provider folders as content://
    // directories. File.create() rejects those URIs, while Directory.createFile()
    // delegates creation to the selected provider on both Android and iOS.
    const backupFile = destinationDirectory.createFile(fileName, 'application/vnd.sqlite3');
    backupFile.write(serialized);
    return { ...counts, fileName, uri: backupFile.uri };
  } finally {
    await destination.closeAsync();
  }
}

/** Selects, validates, and atomically merges a personal backup into this local profile. */
export async function restoreLocalProfileBackupFile(
  destination: SQLiteDatabase,
): Promise<LocalProfileBackupCounts | null> {
  const selection = await File.pickFileAsync({
    mimeTypes: ['application/vnd.sqlite3', 'application/x-sqlite3', 'application/octet-stream'],
  });
  if (selection.canceled || selection.result === null) return null;
  if (selection.result.size > MAX_BACKUP_FILE_BYTES) throw new Error('The selected backup is larger than 25 MB');

  const serialized = await selection.result.bytes();
  const backup = await deserializeDatabaseAsync(serialized, { useNewConnection: true });
  try {
    return await restoreLocalProfileBackup(backup, destination);
  } finally {
    await backup.closeAsync();
  }
}
