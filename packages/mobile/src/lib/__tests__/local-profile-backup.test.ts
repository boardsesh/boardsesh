import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

const fixtures = vi.hoisted(() => ({
  backupBytes: new Uint8Array([83, 81, 76, 105, 116, 101]),
  backupFile: {
    uri: 'content://provider/boardsesh-local.sqlite',
    write: vi.fn(),
  },
  closeAsync: vi.fn(),
  createFile: vi.fn(),
  exportLocalProfileBackup: vi.fn(),
  pickDirectoryAsync: vi.fn(),
  serializeAsync: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: class {
    static pickDirectoryAsync = fixtures.pickDirectoryAsync;

    createFile(name: string, mimeType: string | null) {
      return fixtures.createFile(name, mimeType);
    }
  },
  File: class {
    static pickFileAsync = vi.fn();
  },
}));

vi.mock('expo-sqlite', () => ({
  deserializeDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn(async () => ({
    closeAsync: fixtures.closeAsync,
    serializeAsync: fixtures.serializeAsync,
  })),
}));

vi.mock('../local-profile-backup-core', () => ({
  exportLocalProfileBackup: fixtures.exportLocalProfileBackup,
  restoreLocalProfileBackup: vi.fn(),
}));

import { createLocalProfileBackupFile, isFilePickerCancellation } from '../local-profile-backup';

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.pickDirectoryAsync.mockResolvedValue(
    new (class {
      createFile(name: string, mimeType: string | null) {
        return fixtures.createFile(name, mimeType);
      }
    })(),
  );
  fixtures.createFile.mockReturnValue(fixtures.backupFile);
  fixtures.serializeAsync.mockResolvedValue(fixtures.backupBytes);
  fixtures.exportLocalProfileBackup.mockResolvedValue({
    ticks: 2,
    favorites: 1,
    playlists: 1,
    playlistClimbs: 3,
  });
});

describe('local profile backup provider integration', () => {
  it('creates the backup through the selected provider directory', async () => {
    const source = {} as SQLiteDatabase;

    await expect(createLocalProfileBackupFile(source)).resolves.toMatchObject({
      ticks: 2,
      favorites: 1,
      playlists: 1,
      playlistClimbs: 3,
      uri: fixtures.backupFile.uri,
    });

    expect(fixtures.createFile).toHaveBeenCalledWith(
      expect.stringMatching(/^boardsesh-local-.*\.sqlite$/),
      'application/vnd.sqlite3',
    );
    expect(fixtures.backupFile.write).toHaveBeenCalledWith(fixtures.backupBytes);
    expect(fixtures.closeAsync).toHaveBeenCalledOnce();
  });

  it('does not report success until an asynchronous provider write finishes', async () => {
    let finishWrite: (() => void) | undefined;
    fixtures.backupFile.write.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );

    const backupPromise = createLocalProfileBackupFile({} as SQLiteDatabase);
    await vi.waitFor(() => expect(fixtures.backupFile.write).toHaveBeenCalledOnce());
    expect(fixtures.closeAsync).not.toHaveBeenCalled();

    finishWrite?.();
    await expect(backupPromise).resolves.toMatchObject({ uri: fixtures.backupFile.uri });
    expect(fixtures.closeAsync).toHaveBeenCalledOnce();
  });

  it.each(['ERR_PICKER_CANCELLED', 'ERR_FILE_PICKING_CANCELLED'])('recognizes %s as picker cancellation', (code) => {
    expect(isFilePickerCancellation({ code })).toBe(true);
  });
});
