// @vitest-environment jsdom

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LocalBoard } from '../../../src/lib/boards/local-board';
import type { PendingLocalBoardSetup } from '../../../src/lib/boards/local-board-store';

const localBoard = {
  origin: 'local',
  uuid: 'local-board-uuid',
  slug: 'local-local-board-uuid',
  ownerId: 'local-profile-uuid',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '12,13',
  name: 'Garage wall',
  angle: 40,
  isAngleAdjustable: true,
  createdAt: '2026-08-30T00:00:00.000Z',
} as LocalBoard;

const fixtures = vi.hoisted(() => ({
  saved: null as LocalBoard | null,
  pending: null as PendingLocalBoardSetup | null,
  downloadedScopeKeys: [] as string[],
  durable: true,
  snapshotSource: { uri: 'https://catalog.example/snapshot' } as unknown,
  syncStatus: { isSyncing: false, progress: null } as {
    isSyncing: boolean;
    progress: null | { phase: string; failed?: boolean };
  },
}));

const spies = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  confirmAndDownload: vi.fn(async () => true),
  confirmHook: vi.fn(),
  enableBoardsOffline: vi.fn(),
  isScopeDownloadComplete: vi.fn(async (_database: unknown, _scopeKey: string) => true),
  saveLocalBoard: vi.fn(async (_board: unknown) => {}),
  savePending: vi.fn(async (_pending: unknown) => {}),
  clearPending: vi.fn(async () => {}),
  setActiveBoard: vi.fn(async () => {}),
  setLocalCatalogReady: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: spies.routerReplace }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'local-board-uuid' }));
vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => ({ name: 'offline.sqlite' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@boardsesh/board-config', () => ({ toBoardName: () => 'kilter' }));
vi.mock('@boardsesh/offline-sync', () => ({
  offlineBoardKeyForBoard: () => 'kilter:1:10',
  isScopeDownloadComplete: (database: unknown, scopeKey: string) => spies.isScopeDownloadComplete(database, scopeKey),
}));
vi.mock('../../../src/components/board-discovery/BoardForm', () => ({
  BoardForm: ({ onSubmit, presentation }: { onSubmit: () => void; presentation: string }) => (
    <button type="button" data-presentation={presentation} onClick={onSubmit}>
      submit
    </button>
  ),
}));
vi.mock('../../../src/components/board-discovery/OfflineDownloadProgressBar', () => ({
  OfflineDownloadProgressBar: () => <div>progress</div>,
}));
vi.mock('../../../src/components/board-discovery/board-offline-state', () => ({
  boardDownloadProgress: () => null,
}));
vi.mock('../../../src/components/board-discovery/board-builder-labels', () => ({
  formatDefaultBoardName: () => 'Garage wall',
}));
vi.mock('../../../src/components/board-discovery/use-board-builder', () => ({
  useBoardBuilder: () => ({
    boardName: 'kilter',
    layouts: [],
    sizes: [{ id: 10 }],
    sets: [],
    angles: [40],
    layoutId: 1,
    sizeId: 10,
    setIds: [12, 13],
    angle: 40,
    name: 'Garage wall',
    rawLayoutName: 'Original',
    isAngleAdjustable: true,
    canCreate: true,
    buildCreateInput: () => ({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '12,13',
      angle: 40,
      name: 'Garage wall',
      isAngleAdjustable: true,
    }),
  }),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => <div>loading</div> }));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => spies.setActiveBoard,
}));
vi.mock('../../../src/lib/boards/local-board', () => ({
  createLocalBoard: () => localBoard,
}));
vi.mock('../../../src/lib/boards/local-board-store', () => ({
  getLocalBoard: async () => fixtures.saved,
  getPendingLocalBoardSetup: async () => fixtures.pending,
  saveLocalBoard: (board: LocalBoard) => spies.saveLocalBoard(board),
  savePendingLocalBoardSetup: (pending: PendingLocalBoardSetup) => spies.savePending(pending),
  clearPendingLocalBoardSetup: () => spies.clearPending(),
}));
vi.mock('../../../src/lib/format-bytes', () => ({ formatBytes: () => '10 MB' }));
vi.mock('../../../src/offline/use-board-downloads', () => ({
  useBoardDownloads: () => ({ enableBoardsOffline: spies.enableBoardsOffline }),
}));
vi.mock('../../../src/offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: (options: unknown) => {
    spies.confirmHook(options);
    return { confirmAndDownload: spies.confirmAndDownload };
  },
}));
vi.mock('../../../src/offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: fixtures.downloadedScopeKeys }),
}));
vi.mock('../../../src/offline/use-snapshot-source', () => ({
  useSnapshotSource: () => fixtures.snapshotSource,
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ setLocalCatalogReady: spies.setLocalCatalogReady }),
}));
vi.mock('../../../src/providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ profile: { id: 'local-profile-uuid' }, isLoading: false }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#fff', secondaryLabel: '#666' } }),
}));
vi.mock('../../../src/sync', () => ({ useSyncStatus: () => fixtures.syncStatus }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 3: 12, 4: 16, 6: 24 }, borderRadius: { xl: 20 } }));
vi.mock('../../../src/theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#f00' } }));

import LocalBoardSetupScreen from '../local-setup';

async function renderLoadedSetup() {
  render(<LocalBoardSetupScreen />);
  await waitFor(() => expect(screen.queryByText('mobile.localSetup.loading')).toBeNull());
}

beforeEach(() => {
  cleanup();
  fixtures.saved = null;
  fixtures.pending = null;
  fixtures.downloadedScopeKeys = [];
  fixtures.durable = true;
  fixtures.snapshotSource = { uri: 'https://catalog.example/snapshot' };
  fixtures.syncStatus = { isSyncing: false, progress: null };
  vi.clearAllMocks();
  spies.confirmAndDownload.mockResolvedValue(true);
  spies.isScopeDownloadComplete.mockImplementation(async () => fixtures.durable);
});

describe('local board setup', () => {
  it('uses the local form and disables manifest prefetch before explicit consent', async () => {
    await renderLoadedSetup();

    expect(screen.getByRole('button', { name: 'submit' }).getAttribute('data-presentation')).toBe('local');
    expect(spies.confirmHook).toHaveBeenCalledWith({ prefetchManifest: false });
    expect(spies.confirmAndDownload).not.toHaveBeenCalled();
    expect(spies.setActiveBoard).not.toHaveBeenCalled();
  });

  it('does not enter Climbs when the reported completion is not durable in SQLite', async () => {
    fixtures.downloadedScopeKeys = ['kilter:1:10'];
    fixtures.durable = false;
    await renderLoadedSetup();

    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await waitFor(() => expect(spies.isScopeDownloadComplete).toHaveBeenCalled());
    expect(spies.setActiveBoard).not.toHaveBeenCalled();
    expect(spies.setLocalCatalogReady).not.toHaveBeenCalled();
    expect(spies.routerReplace).not.toHaveBeenCalled();
  });

  it('resumes a pending download after restart and enters only after the durable check', async () => {
    fixtures.pending = { version: 1, board: localBoard, phase: 'downloading' };
    fixtures.downloadedScopeKeys = ['kilter:1:10'];

    await renderLoadedSetup();

    await waitFor(() => expect(spies.routerReplace).toHaveBeenCalledWith('/(tabs)/climbs'));
    expect(spies.isScopeDownloadComplete).toHaveBeenCalledWith({ name: 'offline.sqlite' }, 'kilter:1:10');
    expect(spies.saveLocalBoard).toHaveBeenCalledWith(localBoard);
    expect(spies.setActiveBoard).toHaveBeenCalledWith(localBoard);
    expect(spies.clearPending).toHaveBeenCalled();
    expect(spies.setLocalCatalogReady).toHaveBeenCalledWith(true);
  });

  it('re-enables an already durable saved board before entering Climbs', async () => {
    fixtures.saved = localBoard;
    fixtures.downloadedScopeKeys = ['kilter:1:10'];

    await renderLoadedSetup();

    await waitFor(() => expect(spies.routerReplace).toHaveBeenCalledWith('/(tabs)/climbs'));
    expect(spies.enableBoardsOffline).toHaveBeenCalledWith(localBoard);
    expect(spies.enableBoardsOffline.mock.invocationCallOrder[0]).toBeLessThan(
      spies.setActiveBoard.mock.invocationCallOrder[0],
    );
  });

  it('keeps consent pending when the climber cancels the download dialog', async () => {
    spies.confirmAndDownload.mockResolvedValue(false);
    await renderLoadedSetup();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    });

    await waitFor(() => expect(spies.confirmAndDownload).toHaveBeenCalledWith(localBoard, expect.any(Object)));
    expect(spies.savePending).toHaveBeenCalledWith({
      version: 1,
      board: localBoard,
      phase: 'awaiting-consent',
    });
    expect(spies.setActiveBoard).not.toHaveBeenCalled();
    expect(spies.setLocalCatalogReady).not.toHaveBeenCalled();
  });
});
