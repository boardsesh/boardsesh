// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import {
  emptyScopeDownloadPhases,
  type BootstrapMetadataChangedInfo,
  type ScopeDownloadCompleteInfo,
} from '@boardsesh/offline-sync';
import type { UserBoard } from '@boardsesh/shared-schema';

const fixtures = vi.hoisted(() => ({
  database: { name: 'offline-test-db' },
  queryClient: { invalidateQueries: vi.fn() },
  snapshotSource: { getManifest: vi.fn() },
}));

const spies = vi.hoisted(() => ({
  drainMutationQueue: vi.fn(),
  graphqlRequest: vi.fn(),
  hasUsableInternetConnection: vi.fn(),
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
  hasUsableInternetConnection: spies.hasUsableInternetConnection,
  triggerSync: spies.triggerSync,
}));
vi.mock('../use-snapshot-source', () => ({ useSnapshotSource: () => fixtures.snapshotSource }));
vi.mock('../../lib/graphql/client', () => ({
  getOfflineSyncHttpClient: () => ({ request: spies.graphqlRequest }),
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
let accessMode: 'account' | 'local' = 'account';
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ accessMode }),
}));

import {
  __resetSyncStatusForTests,
  getSyncStatusSnapshot,
  notifyBootstrapMetadataChanged,
  notifyScopeDownloadComplete,
} from '../../sync';
import { setSchemaReady, __resetSchemaReadyForTests } from '../../db/schema-ready';
import { useBoardDownloads } from '../use-board-downloads';

const makeBoard = (uuid: string, boardType: 'kilter' | 'tension', layoutId: number, sizeId: number): UserBoard =>
  ({ uuid, name: uuid, boardType, layoutId, sizeId }) as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  accessMode = 'account';
  __resetSyncStatusForTests();
  // The ordinary launch: init won on its first attempt, so the schema is stamped
  // before any screen renders. The contended launch has its own case below.
  setSchemaReady(true);
  spies.hasUsableInternetConnection.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  __resetSchemaReadyForTests();
});

describe('useBoardDownloads', () => {
  it('uses a catalog-only cycle in local mode even when an account token still exists', async () => {
    accessMode = 'local';
    const board = makeBoard('garage', 'kilter', 1, 10);
    const { result } = renderHook(() => useBoardDownloads());

    result.current.enableBoardsOffline(board);

    expect(spies.triggerSync).toHaveBeenCalledTimes(1);
    const syncCall = spies.triggerSync.mock.calls[0] as unknown[];
    const graphqlFetch = syncCall[2] as () => Promise<unknown>;
    const drainQueue = syncCall[4] as () => Promise<void>;
    const syncOptions = syncCall[5] as { catalogOnly?: boolean };
    expect(syncOptions.catalogOnly).toBe(true);
    await expect(graphqlFetch()).rejects.toThrow('Catalog-only download');
    await expect(drainQueue()).rejects.toThrow('Catalog-only download');
    expect(spies.graphqlRequest).not.toHaveBeenCalled();
    expect(spies.drainMutationQueue).not.toHaveBeenCalled();
    expect(spies.track).not.toHaveBeenCalled();
    expect(spies.rememberDownloadTrigger).not.toHaveBeenCalled();
    expect(spies.rememberOfflineBoards).not.toHaveBeenCalled();
  });

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
    syncOptions?.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:10',
      method: 'snapshot',
      durationMs: 12,
      phases: emptyScopeDownloadPhases(),
    });
    syncOptions?.onScopeDownloadComplete?.({
      scopeKey: 'tension:2:11',
      method: 'paged',
      durationMs: 34,
      phases: emptyScopeDownloadPhases(),
    });

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

  // On a contended launch SQLiteProvider hands out a connection whose migrations
  // never ran, so a download kicked then would import a snapshot into a file with
  // no tables. The tap is held rather than dropped: a "Download" that visibly does
  // nothing is worse than one that starts a moment later, and the discovery nudges
  // aim people straight at this button.
  it('holds a download kicked before the schema is ready, then fires it once readiness lands', () => {
    setSchemaReady(false);
    const board = makeBoard('garage', 'kilter', 1, 10);
    const { result } = renderHook(() => useBoardDownloads());

    result.current.enableBoardsOffline(board);

    // The preference writes are pure settings state and must still land now — the
    // board reads as "offline" in the UI immediately.
    expect(spies.setOfflineBoardEnabled).toHaveBeenCalledTimes(1);
    expect(spies.rememberOfflineBoards).toHaveBeenCalledWith([board]);
    expect(spies.triggerSync).not.toHaveBeenCalled();

    act(() => setSchemaReady(true));

    expect(spies.triggerSync).toHaveBeenCalledTimes(1);
    // Re-read at flush time, never replayed from the captured tap: someone who turns
    // a board on and off again while the schema is unready gets a cycle that finds
    // nothing to do, not the download they cancelled.
    const enabledBoardsReader = spies.triggerSync.mock.calls[0]?.[3] as () => string[];
    expect(enabledBoardsReader()).toEqual(['kilter:1:10', 'tension:2:11']);
  });

  it('does not kick a download on a readiness flip nobody asked for', () => {
    setSchemaReady(false);
    renderHook(() => useBoardDownloads());

    act(() => setSchemaReady(true));

    expect(spies.triggerSync).not.toHaveBeenCalled();
  });

  // A captive portal can look connected to React Query. The explicit NetInfo
  // reachability read must keep that tap armed without starting doomed work.
  it('leaves an armed board waiting when current reachability is false', async () => {
    const board = makeBoard('garage', 'kilter', 1, 10);
    const { result } = renderHook(() => useBoardDownloads());

    result.current.armBoardsOffline(board);
    await act(async () => Promise.resolve());

    expect(spies.setOfflineBoardEnabled).toHaveBeenCalledWith('kilter:1:10', true);
    expect(spies.rememberOfflineBoards).toHaveBeenCalledWith([board]);
    expect(spies.triggerSync).not.toHaveBeenCalled();
  });

  it('kicks an armed board when reconnect already landed before the setting write', async () => {
    spies.hasUsableInternetConnection.mockResolvedValue(true);
    const board = makeBoard('garage', 'kilter', 1, 10);
    const { result } = renderHook(() => useBoardDownloads());

    result.current.armBoardsOffline(board);
    await act(async () => Promise.resolve());

    expect(spies.setOfflineBoardEnabled).toHaveBeenCalledWith('kilter:1:10', true);
    expect(spies.triggerSync).toHaveBeenCalledTimes(1);
  });

  it('re-probes after a transient NetInfo failure instead of losing the wake', async () => {
    vi.useFakeTimers();
    try {
      spies.hasUsableInternetConnection
        .mockRejectedValueOnce(new Error('NetInfo unavailable'))
        .mockResolvedValueOnce(true);
      const board = makeBoard('garage', 'kilter', 1, 10);
      const { result } = renderHook(() => useBoardDownloads());

      result.current.armBoardsOffline(board);
      await act(async () => Promise.resolve());
      expect(spies.triggerSync).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(750));
      expect(spies.hasUsableInternetConnection).toHaveBeenCalledTimes(2);
      expect(spies.triggerSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing for an empty board list on either entry point', () => {
    const { result } = renderHook(() => useBoardDownloads());

    result.current.armBoardsOffline([]);
    result.current.enableBoardsOffline([]);

    expect(spies.setOfflineBoardEnabled).not.toHaveBeenCalled();
    expect(spies.rememberOfflineBoards).not.toHaveBeenCalled();
    expect(spies.triggerSync).not.toHaveBeenCalled();
  });
});
