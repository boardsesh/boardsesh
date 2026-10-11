// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const fixtures = vi.hoisted(() => ({
  database: { name: 'offline-test-db' },
  board: {
    uuid: 'garage',
    name: 'Garage',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
  } as unknown as UserBoard,
}));

const spies = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  enableBoardsOffline: vi.fn(),
  armBoardsOffline: vi.fn(),
  estimateScopeDownload: vi.fn((): { kind: string; bytes?: number; climbCount?: number } => ({
    kind: 'snapshot',
    bytes: 128_000_000,
  })),
  getCheckpoint: vi.fn(),
  getBootstrapDoneMarker: vi.fn(async (): Promise<string | null> => null),
  isScopeDownloadComplete: vi.fn(async () => false),
  notifyBootstrapMetadataChanged: vi.fn(),
  readBootstrapRetryState: vi.fn(async () => ({ state: {} })),
  restoreBootstrapRetryBudget: vi.fn(async () => ({})),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => fixtures.database }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@boardsesh/offline-sync', () => ({
  estimateScopeDownload: spies.estimateScopeDownload,
  getCheckpoint: spies.getCheckpoint,
  getCheckpointKey: (table: string, scopeKey: string) => `${table}:${scopeKey}`,
  getBootstrapDoneMarker: spies.getBootstrapDoneMarker,
  isScopeDownloadComplete: spies.isScopeDownloadComplete,
  readBootstrapRetryState: spies.readBootstrapRetryState,
  restoreBootstrapRetryBudget: spies.restoreBootstrapRetryBudget,
}));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => spies.confirm }));
vi.mock('../use-board-downloads', () => ({
  useBoardDownloads: () => ({
    enableBoardsOffline: spies.enableBoardsOffline,
    armBoardsOffline: spies.armBoardsOffline,
  }),
}));
vi.mock('../use-snapshot-manifest', () => ({
  useSnapshotManifest: () => ({ formatVersion: 1, generatedAt: '2026-08-15T00:00:00.000Z', entries: [] }),
}));
vi.mock('../../settings', () => ({
  offlineBoardKeyForBoard: () => 'kilter:1:10',
  offlineBoardScopeForBoard: () => ({ boardType: 'kilter', layoutId: 1, sizeId: 10 }),
}));
vi.mock('../../lib/format-bytes', () => ({ formatBytes: () => '128 MB' }));
vi.mock('../../sync', () => ({ notifyBootstrapMetadataChanged: spies.notifyBootstrapMetadataChanged }));

import { HOLD_INDEX_BYTES_PER_CLIMB, useConfirmBoardDownload, withHoldIndexLine } from '../use-confirm-board-download';
import { resetSchemaDowngradeForTests, setSchemaDowngrade } from '../../db/schema-downgrade';

beforeEach(() => {
  vi.clearAllMocks();
  spies.confirm.mockResolvedValue(true);
  spies.getCheckpoint.mockResolvedValueOnce({ updatedAt: '2026-08-01T00:00:00.000Z', syncSeq: '1' });
  spies.getCheckpoint.mockResolvedValueOnce(null);
});

afterEach(() => {
  cleanup();
  resetSchemaDowngradeForTests();
});

describe('useConfirmBoardDownload', () => {
  it('marks a size-disclosed partial heal as user-requested before starting it', async () => {
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await expect(result.current.confirmAndDownload(fixtures.board, { trigger: 'toggle' })).resolves.toBe(true);
    });

    expect(spies.restoreBootstrapRetryBudget).toHaveBeenCalledWith(fixtures.database, 'kilter:1:10');
    expect(spies.notifyBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: 'kilter:1:10' });
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(fixtures.board, { trigger: 'toggle' });
  });

  // The engine decides whether an earlier import still counts from the marker's
  // VALUE (issue #6306), so the estimate has to be handed the value, not a
  // yes/no, or it would quote no size for a board the engine imports again.
  it('hands the estimate the raw bootstrap-done marker, so it judges it the way the engine does', async () => {
    spies.getBootstrapDoneMarker.mockResolvedValueOnce('1');
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await result.current.confirmAndDownload(fixtures.board, { trigger: 'toggle' });
    });

    expect(spies.getBootstrapDoneMarker).toHaveBeenCalledWith(fixtures.database, 'kilter:1:10');
    expect(spies.estimateScopeDownload).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapDoneMarker: '1', hasBoardCheckpoint: true, isScopeComplete: false }),
    );
  });
});

// Older JS on a database newer JS migrated: the connection refuses every call, so
// a download cannot start. Every nudge surface reaches the download through this
// hook, so this is where it has to stop.
describe('useConfirmBoardDownload while the offline database belongs to a newer app version', () => {
  beforeEach(() => {
    setSchemaDowngrade({ storedVersion: 11, supportedVersion: 10 });
  });

  it('resolves false without asking, reading or starting anything', async () => {
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await expect(result.current.confirmAndDownload(fixtures.board, { trigger: 'toggle' })).resolves.toBe(false);
    });

    expect(spies.confirm).not.toHaveBeenCalled();
    expect(spies.getCheckpoint).not.toHaveBeenCalled();
    expect(spies.isScopeDownloadComplete).not.toHaveBeenCalled();
    expect(spies.restoreBootstrapRetryBudget).not.toHaveBeenCalled();
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  it('asks again once the database is one this app version can open', async () => {
    resetSchemaDowngradeForTests();
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await expect(result.current.confirmAndDownload(fixtures.board)).resolves.toBe(true);
    });

    expect(spies.confirm).toHaveBeenCalledTimes(1);
  });
});

describe('download quote: holds-index line', () => {
  it('adds the on-phone index size when the manifest has a climb count', async () => {
    spies.estimateScopeDownload.mockReturnValueOnce({ kind: 'snapshot', bytes: 128_000_000, climbCount: 295_000 });
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await result.current.confirmAndDownload(fixtures.board);
    });

    expect(spies.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'mobile.offline.enableMessageWithSize\n\nmobile.offline.enableIndexLine',
      }),
    );
  });

  it('keeps the plain quote without a climb count', async () => {
    const { result } = renderHook(() => useConfirmBoardDownload());

    await act(async () => {
      await result.current.confirmAndDownload(fixtures.board);
    });

    expect(spies.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'mobile.offline.enableMessageWithSize' }),
    );
  });

  it('prices the index at the measured bytes per climb', () => {
    const indexLine = vi.fn((bytes: number) => `index ${bytes}`);
    expect(withHoldIndexLine('quote', 295_000, indexLine)).toBe(
      `quote\n\nindex ${295_000 * HOLD_INDEX_BYTES_PER_CLIMB}`,
    );
    expect(withHoldIndexLine('quote', 0, indexLine)).toBe('quote');
    expect(withHoldIndexLine('quote', null, indexLine)).toBe('quote');
    // ~67 MB for one Kilter size scope, the measured figure.
    expect(295_000 * HOLD_INDEX_BYTES_PER_CLIMB).toBeGreaterThan(65_000_000);
    expect(295_000 * HOLD_INDEX_BYTES_PER_CLIMB).toBeLessThan(70_000_000);
  });
});
