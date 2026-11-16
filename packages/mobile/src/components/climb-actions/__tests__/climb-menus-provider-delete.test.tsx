// @vitest-environment jsdom
// Native view notifications are a no-op; credential storage is outside this host.
vi.mock('../../../lib/graphql/use-auth-token', () => ({ subscribeHttpOperationScope: () => () => {} }));
// Delete from a row's long-press menu, through the real command host: the
// provider, `useClimbActions`, the delete flow and the native HTTP mutation.
// Picking a row clears the selection, which unmounts the executor that ran it,
// so the flow has to keep going without it (regression from #7547). Only the
// platform I/O is stubbed: the dialog, the toast, the outbox and the transport.
import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';

const io = vi.hoisted(() => ({
  pendingTick: vi.fn<(climbUuid: string) => Promise<boolean>>(),
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(),
  showToast: vi.fn(),
  request: vi.fn<(options: { variables: unknown; signal: AbortSignal }) => Promise<unknown>>(),
  executorMounts: 0,
}));

vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: io.request }),
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline I/O');
  },
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: { actions: { label: string }[]; children?: ReactNode; onSelectIndex: (index: number) => void }) =>
    createElement(
      'div',
      null,
      props.children,
      props.actions.map((action, index) =>
        createElement('button', { key: action.label, onClick: () => props.onSelectIndex(index) }, action.label),
      ),
    ),
}));
vi.mock('../../../offline/pending-tick', () => ({ hasQueuedTickForClimb: io.pendingTick }));
vi.mock('../../../offline/assert-climb-delete-ready', () => ({ assertClimbDeleteReady: async () => {} }));
vi.mock('../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: async () => {} }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => io.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: io.showToast }) }));
vi.mock('../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../db/queries/get-favorite-status-local', () => ({ getPendingFavoriteOverridesLocal: vi.fn() }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 0 }));
vi.mock('../../../hooks/use-privacy-scoped-state', () => ({ usePrivacyScopedState: useState }));
vi.mock('../../../hooks/use-is-climb-favorited', () => ({ useIsClimbFavorited: () => false }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => false }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openPlayDrawer: vi.fn(),
    openAddToPlaylist: vi.fn(),
    openLogAscent: vi.fn(),
    openAddBetaVideo: vi.fn(),
    openReportClimb: vi.fn(),
    boardConfig: null,
  }),
  boardConfigsMatch: () => false,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    addToQueue: vi.fn(),
    playNext: vi.fn(),
    setCurrentClimb: vi.fn(),
    findReplayFromHereItem: () => null,
    getQueueSnapshot: () => ({ currentClimbQueueItem: null, queue: [] }),
  }),
  useQueueData: () => ({ queue: [], currentClimbQueueItem: null }),
  useQueueSessionId: () => ({ sessionId: null }),
  useActiveClimbUuid: () => null,
  useIsSharedSession: () => false,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: () => ({ data: false }),
}));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn(async () => {}) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({ useBluetoothConnectedStatus: () => false }));
vi.mock('../../../lib/sentry', () => ({ captureToSentry: vi.fn() }));
// Counts the command host's mounts: the executor mounts this hook only while a
// selection runs, so the count tells the test the host really went away.
vi.mock('../../create-climb/use-create-climb-navigation', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../create-climb/use-create-climb-navigation')>();
  const { useEffect } = await import('react');
  return {
    ...original,
    useCreateClimbNavigation: (...args: Parameters<typeof original.useCreateClimbNavigation>) => {
      useEffect(() => {
        io.executorMounts += 1;
        return () => {
          io.executorMounts -= 1;
        };
      }, []);
      return original.useCreateClimbNavigation(...args);
    },
  };
});

import { ClimbMenu, ClimbMenusProvider, useClimbMenu } from '../ClimbActionsMenu';

const climb = { uuid: 'own-climb', name: 'Pinch Traverse', userId: 'viewer', frames: 'p1r12' } as Climb;
const board = { boardName: 'spray', layoutId: 7, sizeId: 1, setIds: '1', angle: 40 };

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function Row({ target }: { target: ClimbActionsTarget }) {
  const menu = useClimbMenu(target);
  return <ClimbMenu rows={menu.rows} menuKey={menu.menuKey} />;
}
function renderRow(target: ClimbActionsTarget) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ClimbMenusProvider currentUserId="viewer" isAuthenticated activeBoardConfig={board}>
        <Row target={target} />
      </ClimbMenusProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  io.executorMounts = 0;
  io.pendingTick.mockReset().mockResolvedValue(false);
  io.confirm.mockReset().mockResolvedValue(true);
  io.showToast.mockReset();
  io.request.mockReset().mockResolvedValue({ deleteClimb: true });
});
afterEach(cleanup);

describe('Delete from a row menu, after the menu has closed', () => {
  it('asks, deletes and says so once the command host is gone', async () => {
    const tick = deferred<boolean>();
    io.pendingTick.mockReturnValueOnce(tick.promise);
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { client } = renderRow({ climb, boardConfig: board, dismissPlayerAndWait });

    fireEvent.click(screen.getByText('mobile.climbActions.deleteClimb.row'));
    await waitFor(() => expect(io.pendingTick).toHaveBeenCalledWith('own-climb'));
    // The menu closed first: the host that ran the row has unmounted.
    expect(io.executorMounts).toBe(0);

    await act(async () => tick.resolve(false));
    await waitFor(() => expect(io.showToast).toHaveBeenCalled());

    expect(io.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destructive: true }));
    expect(io.request).toHaveBeenCalledOnce();
    const [{ variables, signal }] = io.request.mock.calls[0];
    expect(variables).toEqual({ uuid: 'own-climb', boardType: 'spray' });
    expect(signal.aborted).toBe(false);
    expect(io.showToast).toHaveBeenCalledExactlyOnceWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(dismissPlayerAndWait).toHaveBeenCalledOnce();
    client.clear();
  });

  it('still refuses a climb with a send waiting to sync', async () => {
    io.pendingTick.mockResolvedValueOnce(true);
    const { client } = renderRow({ climb, boardConfig: board });

    fireEvent.click(screen.getByText('mobile.climbActions.deleteClimb.row'));
    await waitFor(() => expect(io.showToast).toHaveBeenCalled());

    expect(io.showToast).toHaveBeenCalledExactlyOnceWith('mobile.climbActions.deleteClimb.pendingTick', 'error');
    expect(io.confirm).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
    client.clear();
  });
});
