// @vitest-environment jsdom
//
// #3897, second surface. My Boards has TWO offline failures and the profile is the
// fatal one: `useProfile` is a plain network query, so with no signal `currentUserId`
// is undefined and the guard `(isError && myBoards.length === 0) || !currentUserId`
// fired the hard "Something went wrong / Try again" state — regardless of anything
// done to the board list. Offline the screen now renders the boards this device
// downloaded, with the network affordances hidden.
//
// #4003 finished the job: the id also comes off the JWT already in SecureStore
// (`useStoredUserId`), so the owned/followed headers come back offline instead of
// filing the user's own wall under "Following". Only when even that is missing does
// the list stay flat.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress?: () => void };
type ManageRowProps = {
  board: UserBoard;
  downloadState?: string;
  downloadCount?: number;
  downloadNotice?: string | null;
  downloadProgress?: { stage: string; fraction: number | null } | null;
  canRetryFastDownload?: boolean;
  onRetryFastDownload?: (board: UserBoard) => void;
  onToggleOffline: (board: UserBoard) => void;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const retryFastDownloadMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const estimateScopeDownloadMock = vi.hoisted(() => vi.fn(() => ({ kind: 'unknown' }) as { kind: string }));
const storedUserIdEnabledMock = vi.hoisted(() => vi.fn());
const reportAbandonedDownloadOnDisableMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));

const state = vi.hoisted(() => ({
  isOffline: false,
  profileId: undefined as string | undefined,
  /** What the JWT already in SecureStore decodes to — the offline id source. */
  storedUserId: undefined as string | undefined,
  isStoredUserIdLoading: false,
  isProfileLoading: false,
  offlineCards: [] as unknown[],
  enabledBoards: [] as string[],
  downloadedScopeKeys: [] as string[],
  bootstrapMetadataByScope: new Map<
    string,
    {
      attempts: number;
      isBootstrapDone: boolean;
      isPagedFallback: boolean;
      hasBoardCheckpoint: boolean;
      isScopeComplete: boolean;
      isTerminal?: boolean;
      retryAfter?: number | null;
    }
  >(),
  bootstrapQueryAsync: false,
  bootstrapMetadataRead: undefined as Promise<ReadonlyMap<string, unknown>> | undefined,
  snapshotSourceAvailable: true,
  /** `offline-download-progress`. Defaults ON, like the real flag. */
  downloadProgressEnabled: true,
  syncStatus: {
    isSyncing: false,
    progress: null as {
      phase: string;
      currentTable: string | null;
      currentTableProcessed?: number;
      snapshot?: {
        scopeKey: string;
        stage: 'manifest' | 'download' | 'import';
        fraction: number | null;
        wireBytes: number | null;
        wireBytesDone: number | null;
      };
    } | null,
    bootstrapMetadataRevision: 0,
    scopeCompletionRevision: 0,
  },
  activeBoard: undefined as unknown,
  myBoards: {
    data: undefined as { boards: unknown[] } | undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
  },
}));

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    isOwned: true,
    ownerId: 'me',
    ...overrides,
  }) as unknown as UserBoard;

function deferred<Result>() {
  let resolvePromise!: (result: Result) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Result>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: { key: string }[];
    renderItem: (input: { item: unknown }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'list' },
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item) => createElement('div', { key: item.key }, renderItem({ item }))),
    ),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string) => {
      const map: Record<string, string> = {
        'mobile.errorTitle': 'Something went wrong',
        'mobile.errorRetry': 'Try again',
        'mobile.emptyTitle': 'No boards yet',
        'mobile.emptySubtitle': 'Search for a board to get started',
        'mobile.discovery.create': 'Create a board',
        'mobile.manage.ownedHeader': 'Your boards',
        'mobile.manage.followingHeader': 'Following',
        'mobile.offline.pickerNotice': "No signal — here are the boards you've downloaded.",
        'mobile.offline.pickerNoticeUnreachable':
          "Can't reach your boards right now — here are the ones you've downloaded.",
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => ({}) }));

vi.mock('@tanstack/react-query', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  type QueryOptions = {
    queryKey: readonly unknown[];
    queryFn: () => unknown;
    enabled?: boolean;
  };

  return {
    useQuery: ({ queryKey, queryFn, enabled = true }: QueryOptions) => {
      const serializedKey = JSON.stringify(queryKey);
      const isBootstrapQuery = queryKey[0] === 'bootstrapMetadataByScope';
      const queryFnRef = React.useRef(queryFn);
      queryFnRef.current = queryFn;
      const [asyncResult, setAsyncResult] = React.useState<{ key: string; data: unknown } | null>(null);

      React.useEffect(() => {
        if (!isBootstrapQuery || !state.bootstrapQueryAsync || !enabled) return;
        let active = true;
        void Promise.resolve(queryFnRef.current()).then(
          (data) => {
            if (active) setAsyncResult({ key: serializedKey, data });
          },
          () => {
            // Match React Query's failed new-key read: keep any prior-key cache,
            // which the screen must reject by revision instead of announcing.
          },
        );
        return () => {
          active = false;
        };
      }, [enabled, isBootstrapQuery, serializedKey]);

      if (!isBootstrapQuery) {
        return { data: state.downloadedScopeKeys, refetch: vi.fn() };
      }
      if (state.bootstrapQueryAsync) {
        return {
          data: asyncResult?.key === serializedKey ? asyncResult.data : undefined,
          refetch: vi.fn(),
        };
      }
      return {
        data: {
          revision: queryKey[1],
          metadataByScope: state.bootstrapMetadataByScope,
        },
        refetch: vi.fn(),
      };
    },
  };
});

vi.mock('@boardsesh/offline-sync', () => ({
  MAX_BOOTSTRAP_ATTEMPTS: 2,
  getDownloadedScopeKeys: vi.fn(async () => state.downloadedScopeKeys),
  getCheckpoint: vi.fn(async () => null),
  getCheckpointKey: (table: string, key: string) => `${table}:${key}`,
  isScopeDownloadComplete: vi.fn(async () => false),
  isBootstrapDone: vi.fn(async () => false),
  readBootstrapRetryState: vi.fn(async () => ({ state: {}, migratedFromLegacy: false })),
  getBootstrapMetadataByScope: vi.fn(async () =>
    state.bootstrapMetadataRead ? await state.bootstrapMetadataRead : state.bootstrapMetadataByScope,
  ),
  estimateScopeDownload: estimateScopeDownloadMock,
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useMyBoards: () => ({ ...state.myBoards, refetch: vi.fn() }),
  useProfile: () => ({
    data: state.profileId ? { id: state.profileId } : undefined,
    isLoading: state.isProfileLoading,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
}));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#eee',
      tertiaryBackground: '#ddd',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ccc',
    },
    brandColors: { primary: '#6D28D9', onPrimary: '#fff' },
  }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => true,
  useOfflineDownloadProgressEnabled: () => state.downloadProgressEnabled,
}));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/hooks/use-is-offline', () => ({ useIsOffline: () => state.isOffline }));
// Mirrors the real hook's contract: disabled → undefined, otherwise the id decoded
// from the stored JWT. Mocked at the hook boundary so this suite never has to pull
// in expo-secure-store.
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: (enabled: boolean) => {
    storedUserIdEnabledMock(enabled);
    if (!enabled) return { userId: undefined, isLoading: false };
    return { userId: state.storedUserId, isLoading: state.isStoredUserIdLoading };
  },
}));
vi.mock('../../../src/sync', () => ({ useSyncStatus: () => state.syncStatus }));
vi.mock('../../../src/offline/use-board-downloads', () => ({
  useBoardDownloads: () => ({ enableBoardsOffline: vi.fn(), retryFastDownload: retryFastDownloadMock }),
}));
vi.mock('../../../src/offline/use-remember-downloaded-boards', () => ({
  useRememberDownloadedBoards: vi.fn(),
}));
vi.mock('../../../src/offline/use-snapshot-manifest', () => ({ useSnapshotManifest: () => null }));
// The download funnel's terminal for a toggle-off (issue #4452). Nothing is
// deleted on that path, so there is no teardown to hang it off — the screen has
// to report it itself.
vi.mock('../../../src/offline/abandoned-download-terminals', () => ({
  reportAbandonedDownloadOnDisable: reportAbandonedDownloadOnDisableMock,
}));
vi.mock('../../../src/offline/use-snapshot-source', () => ({
  useSnapshotSource: () => (state.snapshotSourceAvailable ? {} : undefined),
}));
vi.mock('../../../src/lib/format-bytes', () => ({ formatBytes: (bytes: number) => `${bytes} B` }));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/settings', () => ({
  getSetting: () => state.enabledBoards,
  useSetting: () => [state.enabledBoards, vi.fn()],
  setOfflineBoardEnabled: vi.fn(),
  forgetDownloadTrigger: vi.fn(),
  forgetOfflineBoardScope: vi.fn(),
  useOfflineBoards: () => state.offlineCards,
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
  offlineBoardScopeForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) => ({
    boardType: input.boardType,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
  }),
}));

vi.mock('../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32, 16: 64 },
}));
vi.mock('../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8e8e93', systemRed: '#f00' },
}));

vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/components/board-discovery/BoardManageRow', () => ({
  BoardManageRow: ({
    board: rowBoard,
    downloadState,
    downloadCount,
    downloadNotice,
    downloadProgress,
    canRetryFastDownload,
    onRetryFastDownload,
    onToggleOffline,
  }: ManageRowProps) =>
    createElement(
      'div',
      {
        'data-board': rowBoard.uuid,
        'data-download-state': downloadState ?? '',
        'data-download-count': downloadCount ?? '',
        'data-download-notice': downloadNotice ?? '',
        'data-download-stage': downloadProgress?.stage ?? '',
        'data-can-retry-fast': String(!!canRetryFastDownload),
      },
      rowBoard.name,
      createElement(
        'button',
        { type: 'button', onClick: () => onToggleOffline(rowBoard) },
        `toggle-offline ${rowBoard.uuid}`,
      ),
      canRetryFastDownload && onRetryFastDownload
        ? createElement(
            'button',
            { type: 'button', onClick: () => onRetryFastDownload(rowBoard) },
            `retry-fast ${rowBoard.uuid}`,
          )
        : null,
    ),
}));

const { default: ManageBoards } = await import('../manage');

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(false);
  estimateScopeDownloadMock.mockReturnValue({ kind: 'unknown' });
  state.isOffline = false;
  state.profileId = undefined;
  state.storedUserId = undefined;
  state.isStoredUserIdLoading = false;
  state.isProfileLoading = false;
  state.offlineCards = [];
  state.enabledBoards = [];
  state.downloadedScopeKeys = [];
  state.bootstrapMetadataByScope = new Map();
  state.bootstrapQueryAsync = false;
  state.bootstrapMetadataRead = undefined;
  state.snapshotSourceAvailable = true;
  state.downloadProgressEnabled = true;
  state.syncStatus = {
    isSyncing: false,
    progress: null,
    bootstrapMetadataRevision: 0,
    scopeCompletionRevision: 0,
  };
  state.activeBoard = undefined;
  state.myBoards = { data: undefined, isLoading: false, isError: false, isRefetching: false };
});

describe('My Boards with no usable network list', () => {
  it('passes a persisted snapshot retry notice to the matching board row', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    state.bootstrapMetadataByScope = new Map([
      [
        'kilter:8:17',
        {
          attempts: 1,
          isBootstrapDone: false,
          isPagedFallback: false,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);

    render(createElement(ManageBoards));

    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe(
      'snapshot-retrying',
    );
  });

  it('suppresses stale fallback markers when snapshot bootstrap is unavailable', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    state.snapshotSourceAvailable = false;
    state.bootstrapMetadataByScope = new Map([
      [
        'kilter:8:17',
        {
          attempts: 2,
          isBootstrapDone: false,
          isPagedFallback: true,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);

    render(createElement(ManageBoards));

    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe('');
  });

  it('suppresses stale retry data while flag-off paging is unresolved, then shows the fresh fallback', async () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    const retryMetadata = new Map([
      [
        'kilter:8:17',
        {
          attempts: 1,
          isBootstrapDone: false,
          isPagedFallback: false,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);
    state.bootstrapMetadataByScope = retryMetadata;
    state.bootstrapQueryAsync = true;
    state.bootstrapMetadataRead = Promise.resolve(retryMetadata);

    const { rerender } = render(createElement(ManageBoards));
    await waitFor(() =>
      expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe(
        'snapshot-retrying',
      ),
    );

    state.snapshotSourceAvailable = false;
    rerender(createElement(ManageBoards));
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe('');

    // The ordinary downloader lands a partial page while the snapshot flag is
    // off. Neither bootstrap nor scope-completion revision advances yet.
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'board_data',
        currentTable: 'board_climbs:kilter:8:17',
        currentTableProcessed: 12,
      },
      bootstrapMetadataRevision: 0,
      scopeCompletionRevision: 0,
    };
    const pagedMetadata = new Map([
      [
        'kilter:8:17',
        {
          attempts: 1,
          isBootstrapDone: false,
          isPagedFallback: false,
          hasBoardCheckpoint: true,
          isScopeComplete: false,
          // Both snapshot budgets spent, so this board really is on the crawl.
          isTerminal: true,
        },
      ],
    ]);
    const freshRead = deferred<ReadonlyMap<string, unknown>>();
    state.bootstrapMetadataByScope = pagedMetadata;
    state.bootstrapMetadataRead = freshRead.promise;
    state.snapshotSourceAvailable = true;
    rerender(createElement(ManageBoards));
    // The old retry snapshot must not flash or announce while the new source
    // generation's SQLite read is pending.
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe('');

    await act(async () => freshRead.resolve(pagedMetadata));
    await waitFor(() =>
      expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe(
        'paged-fallback',
      ),
    );
  });

  it('keeps a prior fallback suppressed when the current revision read fails', async () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    const fallbackMetadata = new Map([
      [
        'kilter:8:17',
        {
          attempts: 2,
          isBootstrapDone: false,
          isPagedFallback: true,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);
    state.bootstrapQueryAsync = true;
    state.bootstrapMetadataRead = Promise.resolve(fallbackMetadata);

    const { rerender } = render(createElement(ManageBoards));
    await waitFor(() =>
      expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe(
        'paged-fallback',
      ),
    );

    const failedRead = deferred<ReadonlyMap<string, unknown>>();
    state.bootstrapMetadataRead = failedRead.promise;
    state.syncStatus = {
      ...state.syncStatus,
      bootstrapMetadataRevision: 1,
    };
    rerender(createElement(ManageBoards));
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe('');

    await act(async () => failedRead.reject(new Error('sqlite unavailable')));
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-download-notice')).toBe('');
  });

  it('refreshes scope A metadata while scope B is still bootstrapping', async () => {
    state.profileId = 'me';
    state.myBoards = {
      data: {
        boards: [
          board({ uuid: 'board-a', name: 'Board A' }),
          board({ uuid: 'board-b', name: 'Board B', boardType: 'tension', layoutId: 2, sizeId: 10 }),
        ],
      },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17', 'tension:2:10'];
    const preRunFallback = {
      attempts: 0,
      isBootstrapDone: false,
      isPagedFallback: true,
      hasBoardCheckpoint: false,
      isScopeComplete: false,
    };
    const initialMetadata = new Map([
      ['kilter:8:17', preRunFallback],
      ['tension:2:10', preRunFallback],
    ]);
    state.bootstrapQueryAsync = true;
    state.bootstrapMetadataRead = Promise.resolve(initialMetadata);

    const { rerender } = render(createElement(ManageBoards));
    await waitFor(() =>
      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-notice')).toBe(
        'paged-fallback',
      ),
    );

    const freshMetadata = new Map([
      [
        'kilter:8:17',
        {
          ...preRunFallback,
          attempts: 1,
          isPagedFallback: false,
        },
      ],
      ['tension:2:10', preRunFallback],
    ]);
    const freshRead = deferred<ReadonlyMap<string, unknown>>();
    state.bootstrapMetadataRead = freshRead.promise;
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'bootstrap',
        currentTable: 'tension:2:10',
      },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 0,
    };
    rerender(createElement(ManageBoards));

    // Scope A's old fallback belongs to revision 0 and must not survive while
    // revision 1 is reading A's just-settled outcome. Scope B remains visibly
    // active from the independent progress frame.
    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-notice')).toBe('');
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-state')).toBe('downloading');

    await act(async () => freshRead.resolve(freshMetadata));
    await waitFor(() =>
      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-notice')).toBe(
        'snapshot-retrying',
      ),
    );
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-state')).toBe('downloading');
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-notice')).toBe('');
  });

  // The download-progress kill switch has two halves: `useSnapshotSource` drops
  // the native byte callback, and the screen drops the frames. The engine flushes
  // its three stage frames either way, so without the second half a build with
  // `offline-download-progress` off would show "Downloading 0 MB of 103 MB" and a
  // bar pinned at 0 for the whole download — worse than the caption it restores.
  const renderBootstrappingRow = () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    state.bootstrapMetadataByScope = new Map([
      [
        'kilter:8:17',
        {
          attempts: 1,
          isBootstrapDone: false,
          isPagedFallback: false,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'bootstrap',
        currentTable: 'kilter:8:17',
        snapshot: {
          scopeKey: 'kilter:8:17',
          stage: 'download',
          fraction: 0.4,
          wireBytes: 103_000_000,
          wireBytesDone: 41_200_000,
        },
      },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 0,
    };
    render(createElement(ManageBoards));
    return document.querySelector('[data-board="net-1"]');
  };

  it('hands the downloading row its live snapshot frame', () => {
    expect(renderBootstrappingRow()?.getAttribute('data-download-stage')).toBe('download');
  });

  it('withholds the snapshot frame from the row when the progress kill switch is off', () => {
    state.downloadProgressEnabled = false;
    const row = renderBootstrappingRow();
    expect(row?.getAttribute('data-download-stage')).toBe('');
    expect(row?.getAttribute('data-download-state')).toBe('downloading');
  });

  it('keeps fallback active with a live count while board_climb_grades downloads', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    state.bootstrapMetadataByScope = new Map([
      [
        'kilter:8:17',
        {
          attempts: 2,
          isBootstrapDone: false,
          isPagedFallback: true,
          hasBoardCheckpoint: true,
          isScopeComplete: false,
        },
      ],
    ]);
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'board_data',
        currentTable: 'board_climb_grades:kilter:8:17',
        currentTableProcessed: 73,
      },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 0,
    };

    render(createElement(ManageBoards));

    const row = document.querySelector('[data-board="net-1"]');
    expect(row?.getAttribute('data-download-state')).toBe('downloading');
    expect(row?.getAttribute('data-download-notice')).toBe('paged-fallback');
    expect(row?.getAttribute('data-download-count')).toBe('73');
  });

  it.each(['deletions', 'user_data'] as const)(
    'shows incomplete scopes as finalizing during shared %s work',
    (phase) => {
      state.profileId = 'me';
      state.myBoards = {
        data: {
          boards: [
            board({ uuid: 'board-a', name: 'Board A' }),
            board({ uuid: 'board-b', name: 'Board B', boardType: 'tension', layoutId: 2, sizeId: 10 }),
            board({ uuid: 'board-c', name: 'Board C', boardType: 'tension', layoutId: 3, sizeId: 12 }),
          ],
        },
        isLoading: false,
        isError: false,
        isRefetching: false,
      };
      state.enabledBoards = ['kilter:8:17', 'tension:2:10', 'tension:3:12'];
      state.downloadedScopeKeys = ['kilter:8:17'];
      state.bootstrapMetadataByScope = new Map([
        [
          'tension:2:10',
          {
            attempts: 0,
            isBootstrapDone: true,
            isPagedFallback: false,
            hasBoardCheckpoint: true,
            isScopeComplete: false,
          },
        ],
        [
          'tension:3:12',
          {
            attempts: 1,
            isBootstrapDone: false,
            isPagedFallback: true,
            hasBoardCheckpoint: false,
            isScopeComplete: false,
            isTerminal: true,
          },
        ],
      ]);
      state.syncStatus = {
        isSyncing: true,
        progress: {
          phase,
          currentTable: phase === 'user_data' ? 'boardsesh_ticks' : null,
        },
        bootstrapMetadataRevision: 0,
        scopeCompletionRevision: 0,
      };

      render(createElement(ManageBoards));

      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('downloaded');
      expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-state')).toBe('finalizing');
      expect(document.querySelector('[data-board="board-c"]')?.getAttribute('data-download-state')).toBe('pending');
      expect(document.querySelector('[data-board="board-c"]')?.getAttribute('data-download-notice')).toBe(
        'paged-fallback',
      );
    },
  );

  it.each([
    ['bootstrap', 'tension:2:10', false],
    ['board_data', 'board_climbs:tension:2:10', true],
  ] as const)(
    'keeps imported scope A finalizing while scope B is active in %s',
    (phase, currentTable, isSecondBootstrapDone) => {
      state.profileId = 'me';
      state.myBoards = {
        data: {
          boards: [
            board({ uuid: 'board-a', name: 'Board A' }),
            board({ uuid: 'board-b', name: 'Board B', boardType: 'tension', layoutId: 2, sizeId: 10 }),
          ],
        },
        isLoading: false,
        isError: false,
        isRefetching: false,
      };
      state.enabledBoards = ['kilter:8:17', 'tension:2:10'];
      state.bootstrapMetadataByScope = new Map([
        [
          'kilter:8:17',
          {
            attempts: 0,
            isBootstrapDone: true,
            isPagedFallback: false,
            hasBoardCheckpoint: true,
            isScopeComplete: false,
          },
        ],
        [
          'tension:2:10',
          {
            attempts: 0,
            isBootstrapDone: isSecondBootstrapDone,
            isPagedFallback: false,
            hasBoardCheckpoint: isSecondBootstrapDone,
            isScopeComplete: false,
          },
        ],
      ]);
      state.syncStatus = {
        isSyncing: true,
        progress: { phase, currentTable },
        bootstrapMetadataRevision: isSecondBootstrapDone ? 2 : 1,
        scopeCompletionRevision: 0,
      };

      render(createElement(ManageBoards));

      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('finalizing');
      expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-state')).toBe('downloading');
    },
  );

  it('uses the bootstrap metadata revision to finalize the last imported scope at deletion handoff', async () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'board-a', name: 'Board A' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    const beforeImport = new Map([
      [
        'kilter:8:17',
        {
          attempts: 0,
          isBootstrapDone: false,
          isPagedFallback: false,
          hasBoardCheckpoint: false,
          isScopeComplete: false,
        },
      ],
    ]);
    state.bootstrapQueryAsync = true;
    state.bootstrapMetadataRead = Promise.resolve(beforeImport);
    state.syncStatus = {
      isSyncing: true,
      progress: { phase: 'bootstrap', currentTable: 'kilter:8:17' },
      bootstrapMetadataRevision: 0,
      scopeCompletionRevision: 0,
    };

    const { rerender } = render(createElement(ManageBoards));
    await waitFor(() =>
      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('downloading'),
    );

    const afterImport = new Map([
      [
        'kilter:8:17',
        {
          attempts: 0,
          isBootstrapDone: true,
          isPagedFallback: false,
          hasBoardCheckpoint: true,
          isScopeComplete: false,
        },
      ],
    ]);
    const refreshedMetadata = deferred<ReadonlyMap<string, unknown>>();
    state.bootstrapMetadataRead = refreshedMetadata.promise;
    state.syncStatus = {
      isSyncing: true,
      progress: { phase: 'deletions', currentTable: null },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 0,
    };
    rerender(createElement(ManageBoards));

    // The prior revision's unfinished marker is rejected while the new-key read
    // is pending, so the row cannot claim finalizing until SQLite confirms it.
    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('pending');

    await act(async () => refreshedMetadata.resolve(afterImport));
    await waitFor(() =>
      expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('finalizing'),
    );
  });

  it('clears the first scope on completion while a second scope keeps downloading', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: {
        boards: [
          board({ uuid: 'board-a', name: 'Board A' }),
          board({ uuid: 'board-b', name: 'Board B', boardType: 'tension', layoutId: 2, sizeId: 10 }),
        ],
      },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17', 'tension:2:10'];
    const fallbackMetadata = {
      attempts: 2,
      isBootstrapDone: false,
      isPagedFallback: true,
      hasBoardCheckpoint: false,
      isScopeComplete: false,
    };
    state.bootstrapMetadataByScope = new Map([
      ['kilter:8:17', fallbackMetadata],
      ['tension:2:10', fallbackMetadata],
    ]);
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'board_data',
        currentTable: 'board_climbs:kilter:8:17',
        currentTableProcessed: 42,
      },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 0,
    };

    const { rerender } = render(createElement(ManageBoards));
    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('downloading');
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-notice')).toBe(
      'paged-fallback',
    );

    // onScopeDownloadComplete has committed board A's marker and advanced the
    // query revision even though board B is still mid-cycle.
    // Deliberately leave the separate downloaded-scope query stale: the batch's
    // committed scope-complete marker must still clear the row immediately.
    state.downloadedScopeKeys = [];
    state.bootstrapMetadataByScope = new Map([
      ['kilter:8:17', { ...fallbackMetadata, hasBoardCheckpoint: true, isScopeComplete: true }],
      ['tension:2:10', fallbackMetadata],
    ]);
    state.syncStatus = {
      isSyncing: true,
      progress: {
        phase: 'board_data',
        currentTable: 'board_climbs:tension:2:10',
        currentTableProcessed: 7,
      },
      bootstrapMetadataRevision: 1,
      scopeCompletionRevision: 1,
    };
    rerender(createElement(ManageBoards));

    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('downloaded');
    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-notice')).toBe('');
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-state')).toBe('downloading');
    expect(document.querySelector('[data-board="board-b"]')?.getAttribute('data-download-notice')).toBe(
      'paged-fallback',
    );
  });

  it('renders the downloaded boards instead of the hard error state when the profile is missing', () => {
    state.isOffline = true;
    state.offlineCards = [board({ uuid: 'board-a', name: 'Marco garage' })];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(ManageBoards));

    // On today's code `!currentUserId` short-circuits straight to the error state.
    expect(screen.getByText('Marco garage')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.getByText("No signal — here are the boards you've downloaded.")).toBeTruthy();
  });

  // Create is the last network-only affordance on this screen: #4623 moved edit,
  // delete and unfollow onto the /boards picker cards, so there is no per-row
  // mutation left to hide. What remains is that the offline list offers no way to
  // POST a new board while the rows keep their local offline toggle.
  it('hides Create offline while the local offline toggle keeps working', () => {
    state.isOffline = true;
    state.offlineCards = [board({ uuid: 'board-a', name: 'Marco garage' })];
    state.enabledBoards = ['kilter:8:17'];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(ManageBoards));

    expect(screen.queryByRole('button', { name: 'Create a board' })).toBeNull();
    // The local offline toggle keeps working — its state comes off disk, not the wire.
    expect(document.querySelector('[data-board="board-a"]')?.getAttribute('data-download-state')).toBe('downloaded');
    expect(screen.getByText('toggle-offline board-a')).toBeTruthy();
  });

  it('leaves the owned/followed split and the Create button alone online', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.offlineCards = [board({ uuid: 'board-a', name: 'Marco garage' })];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(ManageBoards));

    expect(screen.getByText('Your boards')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a board' })).toBeTruthy();
    expect(screen.getByText('Network board')).toBeTruthy();
    expect(screen.queryByText('Marco garage')).toBeNull();
  });

  it('degrades to the downloaded list, not the error state, when the profile fails online', () => {
    // Reviewer-flagged path: online, boards loaded, but the profile settled with no
    // id (e.g. a 401 on that query alone). Today that shows the hard error state;
    // owned-vs-followed is unclassifiable, so the downloaded list is the honest render.
    state.isOffline = false;
    state.profileId = undefined;
    state.isProfileLoading = false;
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.offlineCards = [board({ uuid: 'board-a', name: 'Marco garage' })];
    state.enabledBoards = ['kilter:8:17'];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(ManageBoards));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByText('Marco garage')).toBeTruthy();
    expect(screen.queryByText('Your boards')).toBeNull();
    // Online with a dead profile request: the notice must not claim there is no signal.
    expect(screen.getByText("Can't reach your boards right now — here are the ones you've downloaded.")).toBeTruthy();
  });

  // Issue #4452. Turning a board off deletes nothing, so no teardown reports for
  // it — but the scope leaves `syncEnabledBoards` and pullSync only ever visits
  // enabled scopes, so the download is over for good and its
  // `Offline Board Download Started` would otherwise stay open forever.
  it('closes the download funnel when a board is toggled off', async () => {
    state.profileId = 'me';
    state.enabledBoards = ['kilter:8:17'];
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(ManageBoards));
    await act(async () => {
      fireEvent.click(screen.getByText('toggle-offline net-1'));
    });

    await waitFor(() => expect(reportAbandonedDownloadOnDisableMock).toHaveBeenCalledWith({}, 'kilter:8:17'));
  });

  // The other direction: enabling a board goes through the size-quote confirm,
  // and there is no download of its own to close.
  it('reports nothing when a board is toggled ON', async () => {
    state.profileId = 'me';
    state.enabledBoards = [];
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(ManageBoards));
    await act(async () => {
      fireEvent.click(screen.getByText('toggle-offline net-1'));
    });

    expect(reportAbandonedDownloadOnDisableMock).not.toHaveBeenCalled();
  });

  it('still shows the retry state offline when nothing has been downloaded', () => {
    state.isOffline = true;

    render(createElement(ManageBoards));

    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });
});

describe('My Boards offline with a persisted user id (#4003)', () => {
  it("files the user's own wall under Your boards and the rest under Following", () => {
    state.isOffline = true;
    state.storedUserId = 'me';
    state.offlineCards = [
      board({ uuid: 'board-a', name: 'Marco garage', ownerId: 'me', isOwned: true }),
      board({ uuid: 'board-b', name: 'City gym', ownerId: 'someone-else', isOwned: false, layoutId: 9 }),
    ];
    state.downloadedScopeKeys = ['kilter:8:17', 'kilter:9:17'];

    render(createElement(ManageBoards));

    const rendered = [...document.querySelectorAll('[data-testid="list"] span, [data-board]')].map(
      (node) => node.getAttribute('data-board') ?? node.textContent,
    );
    expect(rendered).toEqual(expect.arrayContaining(['Your boards', 'board-a', 'Following', 'board-b']));
    expect(rendered.indexOf('Your boards')).toBeLessThan(rendered.indexOf('board-a'));
    expect(rendered.indexOf('board-a')).toBeLessThan(rendered.indexOf('Following'));
    expect(rendered.indexOf('Following')).toBeLessThan(rendered.indexOf('board-b'));
  });

  it('stays flat when the keychain yields no id at all', () => {
    state.isOffline = true;
    state.storedUserId = undefined;
    state.offlineCards = [board({ uuid: 'board-a', name: 'Marco garage' })];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(ManageBoards));

    expect(screen.getByText('Marco garage')).toBeTruthy();
    expect(screen.queryByText('Your boards')).toBeNull();
    expect(screen.queryByText('Following')).toBeNull();
  });

  it('keeps the normal grouped list online when only the profile request fails', () => {
    // Previously this fell through to the read-only offline list, because the
    // profile was the only id source. The JWT answers instead, so the live board
    // list renders as usual.
    state.isOffline = false;
    state.profileId = undefined;
    state.storedUserId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board', ownerId: 'me' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(ManageBoards));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByText('Your boards')).toBeTruthy();
    expect(screen.getByText('Network board')).toBeTruthy();
  });

  it('holds the spinner while the keychain read is still in flight', () => {
    // The profile settled with nothing, but the JWT read hasn't come back yet.
    // Rendering here would flash the error state on the way to the grouped list.
    state.isOffline = false;
    state.profileId = undefined;
    state.isProfileLoading = false;
    state.isStoredUserIdLoading = true;
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(ManageBoards));

    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText('Network board')).toBeNull();
  });

  it('never reads the keychain once the profile has answered', () => {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(ManageBoards));

    expect(storedUserIdEnabledMock).toHaveBeenCalled();
    expect(storedUserIdEnabledMock.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
  });
});

describe('My Boards: retrying the fast download (#4313)', () => {
  const settledMetadata = {
    attempts: 2,
    isBootstrapDone: false,
    isPagedFallback: true,
    hasBoardCheckpoint: true,
    isScopeComplete: false,
    isTerminal: true,
    retryAfter: null,
  };

  function renderWithMetadata(metadata: Record<string, unknown>): void {
    state.profileId = 'me';
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.enabledBoards = ['kilter:8:17'];
    state.bootstrapMetadataByScope = new Map([['kilter:8:17', metadata]]) as typeof state.bootstrapMetadataByScope;
    render(createElement(ManageBoards));
  }

  it('offers the retry only for a settled board that has not finished downloading', () => {
    renderWithMetadata(settledMetadata);
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-can-retry-fast')).toBe('true');
  });

  it('does not offer it while a snapshot attempt is still scheduled', () => {
    renderWithMetadata({ ...settledMetadata, isTerminal: false, retryAfter: 1_800_000_000_000 });
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-can-retry-fast')).toBe('false');
  });

  it('does not offer it to a board that already holds the whole catalog', () => {
    renderWithMetadata({ ...settledMetadata, isScopeComplete: true });
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-can-retry-fast')).toBe('false');
  });

  it('does not offer it to a board that already imported an artifact', () => {
    renderWithMetadata({ ...settledMetadata, isBootstrapDone: true });
    expect(document.querySelector('[data-board="net-1"]')?.getAttribute('data-can-retry-fast')).toBe('false');
  });

  it('quotes the download size in the confirm and restores the budget only when accepted', async () => {
    estimateScopeDownloadMock.mockReturnValue({ kind: 'snapshot', bytes: 103_000_000 } as { kind: string });
    confirmMock.mockResolvedValue(true);
    renderWithMetadata(settledMetadata);

    fireEvent.click(screen.getByText('retry-fast net-1'));

    await waitFor(() => expect(retryFastDownloadMock).toHaveBeenCalled());
    // The estimate is asked for the user-requested verdict, not the persisted
    // terminal one — restoring the budget IS the action being confirmed.
    expect(estimateScopeDownloadMock).toHaveBeenCalledWith(expect.objectContaining({ userRequested: true }));
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'mobile.offline.retryFastDownloadMessageWithSize' }),
    );
  });

  it('does nothing when the confirm is dismissed', async () => {
    confirmMock.mockResolvedValue(false);
    renderWithMetadata(settledMetadata);

    fireEvent.click(screen.getByText('retry-fast net-1'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(retryFastDownloadMock).not.toHaveBeenCalled();
  });
});
