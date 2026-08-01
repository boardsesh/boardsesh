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
  setOfflineBoardEnabled: vi.fn(),
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
  offlineBoardScopeForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  rememberOfflineBoards: spies.rememberOfflineBoards,
  setOfflineBoardEnabled: spies.setOfflineBoardEnabled,
}));

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
});
