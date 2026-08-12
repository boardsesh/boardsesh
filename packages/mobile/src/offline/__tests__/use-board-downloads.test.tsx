// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { BootstrapMetadataChangedInfo, ScopeDownloadCompleteInfo } from '@boardsesh/offline-sync';
import type { UserBoard } from '@boardsesh/shared-schema';

const fixtures = vi.hoisted(() => ({
  database: { name: 'offline-test-db' },
  queryClient: { invalidateQueries: vi.fn() },
  snapshotSource: { getManifest: vi.fn() },
}));

const spies = vi.hoisted(() => ({
  drainMutationQueue: vi.fn(),
  graphqlRequest: vi.fn(),
  rememberOfflineBoards: vi.fn(),
  rememberDownloadTrigger: vi.fn(),
  setOfflineBoardEnabled: vi.fn(),
  track: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => fixtures.database }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => fixtures.queryClient }));
vi.mock('../offline-sync-adapter', () => ({
  drainMutationQueue: spies.drainMutationQueue,
  triggerSync: spies.triggerSync,
}));
vi.mock('../use-snapshot-source', () => ({ useSnapshotSource: () => fixtures.snapshotSource }));
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: spies.graphqlRequest }),
}));
vi.mock('../../settings', () => ({
  getSetting: () => ['kilter:1:10', 'tension:2:11'],
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  offlineBoardScopeForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  rememberOfflineBoards: spies.rememberOfflineBoards,
  rememberDownloadTrigger: spies.rememberDownloadTrigger,
  setOfflineBoardEnabled: spies.setOfflineBoardEnabled,
}));
vi.mock('../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../lib/offline-engine', () => ({ isOfflineEngineEnabled: () => true }));

import {
  __resetSyncStatusForTests,
  getSyncStatusSnapshot,
  notifyBootstrapMetadataChanged,
  notifyScopeDownloadComplete,
} from '../../sync';
import { useBoardDownloads } from '../use-board-downloads';

const makeBoard = (uuid: string, boardType: 'kilter' | 'tension', layoutId: number, sizeId: number): UserBoard =>
  ({ uuid, name: uuid, boardType, layoutId, sizeId }) as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  __resetSyncStatusForTests();
});

afterEach(() => cleanup());

describe('useBoardDownloads', () => {
  it('advances bootstrap and completion revisions for every scope in one ad-hoc multi-board sync', () => {
    const boards = [makeBoard('garage', 'kilter', 1, 10), makeBoard('gym', 'tension', 2, 11)];
    const { result } = renderHook(() => useBoardDownloads());

    result.current.enableBoardsOffline(boards);

    expect(spies.setOfflineBoardEnabled).toHaveBeenCalledTimes(2);
    expect(spies.rememberOfflineBoards).toHaveBeenCalledWith(boards);
    expect(spies.triggerSync).toHaveBeenCalledTimes(1);

    const syncOptions = spies.triggerSync.mock.calls[0]?.[5] as
      | {
          onBootstrapMetadataChanged?: (info: BootstrapMetadataChangedInfo) => void;
          onScopeDownloadComplete?: (info: ScopeDownloadCompleteInfo) => void;
        }
      | undefined;
    expect(syncOptions?.onBootstrapMetadataChanged).toBe(notifyBootstrapMetadataChanged);
    expect(syncOptions?.onScopeDownloadComplete).toBe(notifyScopeDownloadComplete);

    syncOptions?.onBootstrapMetadataChanged?.({ scopeKey: 'kilter:1:10' });
    syncOptions?.onBootstrapMetadataChanged?.({ scopeKey: 'tension:2:11' });
    syncOptions?.onScopeDownloadComplete?.({ scopeKey: 'kilter:1:10', method: 'snapshot', durationMs: 12 });
    syncOptions?.onScopeDownloadComplete?.({ scopeKey: 'tension:2:11', method: 'paged', durationMs: 34 });

    expect(getSyncStatusSnapshot().bootstrapMetadataRevision).toBe(2);
    expect(getSyncStatusSnapshot().scopeCompletionRevision).toBe(2);
  });

  it('enables and announces once per SCOPE when two boards share one', () => {
    // Two gyms with the same wall are one offline scope and one download, so a
    // per-board Toggled would count two enables against the downloader's single
    // Started. Download-all is where this lands: its "missing" filter runs
    // against the pre-batch enabled set, so both siblings come through.
    const boards = [makeBoard('garage', 'kilter', 1, 10), makeBoard('gym', 'kilter', 1, 10)];
    const { result } = renderHook(() => useBoardDownloads());

    result.current.enableBoardsOffline(boards, { trigger: 'download-all', source: 'more' });

    expect(spies.setOfflineBoardEnabled).toHaveBeenCalledTimes(1);
    expect(spies.rememberDownloadTrigger).toHaveBeenCalledTimes(1);
    expect(spies.rememberDownloadTrigger).toHaveBeenCalledWith('kilter:1:10', 'download-all');
    expect(spies.track).toHaveBeenCalledTimes(1);
    // Both board cards are still remembered — that list is per-board, and the
    // offline picker needs a row for each.
    expect(spies.rememberOfflineBoards).toHaveBeenCalledWith(boards);
    expect(spies.triggerSync).toHaveBeenCalledTimes(1);
  });
});
