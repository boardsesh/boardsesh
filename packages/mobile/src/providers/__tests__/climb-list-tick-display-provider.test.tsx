// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import {
  BoardAdapterProvider,
  BoardProvider,
  accumulatedLogbookQueryKey,
  fetchedLogbookClimbUuidsQueryKey,
  toLogbookEntry,
  type BoardAdapter,
  type ExecuteHttp,
  type LogbookEntry,
  type LogbookSourceTick,
} from '@boardsesh/board-react';

const controls = vi.hoisted(() => ({
  authenticated: true,
  authLoading: false,
  offlineEnabled: true,
  viewerId: 'user-a',
  authEpoch: 0,
  credentialScope: 0,
  complete: true,
  database: {} as object | null,
  databaseListeners: new Set<() => void>(),
  credentialListeners: new Set<() => void>(),
  readTicks: vi.fn(),
  readIdentity: vi.fn(),
  executeHttp: vi.fn(),
  thumbnailRender: vi.fn(() => null),
}));

vi.mock('../auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: controls.authenticated, isLoading: controls.authLoading }),
}));
vi.mock('../feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => controls.offlineEnabled }));
vi.mock('../../hooks/use-privacy-scoped-state', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePrivacyCredentialScope: () =>
      useSyncExternalStore(
        (listener) => {
          controls.credentialListeners.add(listener);
          return () => controls.credentialListeners.delete(listener);
        },
        () => controls.credentialScope,
      ),
  };
});
vi.mock('../../db/connection', () => ({
  getDatabaseHandle: () => controls.database,
  subscribeDatabaseHandle: (listener: () => void) => {
    controls.databaseListeners.add(listener);
    return () => controls.databaseListeners.delete(listener);
  },
}));
vi.mock('../../db/queries/get-climb-ticks-local', () => ({ readClimbTicksLocal: controls.readTicks }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/offline-sync')>()),
  canServeLocalUserData: async () => controls.complete,
}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => controls.authEpoch,
  isAuthCredentialGenerationCurrent: (epoch: number) => epoch === controls.authEpoch,
}));
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId: controls.readIdentity }));
vi.mock('../../hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => true }));
vi.mock('../../hooks/use-local-my-grade', () => ({ useLocalMyGrade: () => undefined }));
vi.mock('../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => false,
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V4', color: '#111111' }) }),
}));
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../theme-provider', () => ({
  useTheme: () => ({ textStyles: { body: { lineHeight: 22 } }, systemColors: { secondaryLabel: '#8E8E93' } }),
}));
vi.mock('../../lib/climb-row-display-preference', async () => {
  const { DEFAULT_CLIMB_ROW_DISPLAY } = await import('../../lib/climb-row-display');
  return { useClimbRowDisplay: () => DEFAULT_CLIMB_ROW_DISPLAY };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: 1 }),
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../components/Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));
vi.mock('../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../components/ClimbListThumbnail', () => ({
  ClimbListThumbnail: controls.thumbnailRender,
  THUMBNAIL_WIDTH: 60,
  THUMBNAIL_HEIGHT: 80,
}));
vi.mock('../../components/ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../components/ClimbPlaylistChips', () => ({ ClimbPlaylistChips: () => null }));

import { ClimbListTickDisplayProvider } from '../climb-list-tick-display-provider';
import { ClimbListItemContent, type ClimbListItemClimb } from '../../components/ClimbListItemContent';

function tick(overrides: Partial<LogbookSourceTick> = {}): LogbookEntry {
  return toLogbookEntry({
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: 20,
    comment: '',
    climbedAt: '2026-10-10T12:00:00.000Z',
    ...overrides,
  });
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const climbUuids = ['climb-1'];
const baseClimb = { uuid: 'climb-1', name: 'First row', frames: 'p1r1', difficulty: 'V4', quality_average: '0' };

function renderList(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'offlineFirst' } } }),
  rowClimb: ClimbListItemClimb = baseClimb,
) {
  const tree = () => {
    const adapter: BoardAdapter = {
      isAuthenticated: controls.authenticated,
      isAuthLoading: controls.authLoading,
      executeHttp: controls.executeHttp as ExecuteHttp,
      executeWs: async () => {
        throw new Error('No websocket operation expected');
      },
      resolveActiveSessionId: () => undefined,
    };
    return (
      <QueryClientProvider client={queryClient}>
        <BoardAdapterProvider value={adapter}>
          <BoardProvider boardName="kilter">
            <ClimbListTickDisplayProvider boardName="kilter" climbUuids={climbUuids}>
              <ClimbListItemContent climb={rowClimb} boardName="kilter" layoutId={1} sizeId={1} setIds="1" angle={40} />
            </ClimbListTickDisplayProvider>
          </BoardProvider>
        </BoardAdapterProvider>
      </QueryClientProvider>
    );
  };
  const rendered = render(tree());
  return { ...rendered, queryClient, rerenderList: () => rendered.rerender(tree()) };
}

function hasIcon(container: HTMLElement, name: string): boolean {
  return container.querySelector(`[data-icon="${name}"]`) !== null;
}

beforeEach(() => {
  controls.authenticated = true;
  controls.authLoading = false;
  controls.offlineEnabled = true;
  controls.viewerId = 'user-a';
  controls.authEpoch = 0;
  controls.credentialScope = 0;
  controls.complete = true;
  controls.database = {};
  controls.readTicks.mockReset().mockResolvedValue([tick()]);
  controls.readIdentity.mockReset().mockImplementation(async () => controls.viewerId);
  controls.executeHttp.mockReset().mockImplementation(() => new Promise(() => {}));
  controls.thumbnailRender.mockClear();
  onlineManager.setOnline(true);
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe('climb-list tick display', () => {
  it.each(['send', 'attempt'] as const)(
    'renders a preloaded %s and personal grade on the first row render',
    (status) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [tick({ status })]);
      queryClient.setQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'), new Set(climbUuids));
      const { container } = renderList(queryClient);
      expect(hasIcon(container, status === 'send' ? 'tick.outline' : 'ascent.attempt')).toBe(true);
      expect(hasIcon(container, 'person')).toBe(true);
      expect(container.querySelector('[data-variant="title3"]')?.textContent).not.toBe('V4');
    },
  );

  it.each(['send', 'attempt'] as const)(
    'reads cold offline %s rows without opening climbs or marking server history fetched',
    async (status) => {
      controls.readTicks.mockResolvedValue([tick({ status })]);
      onlineManager.setOnline(false);
      const { container, queryClient } = renderList();
      await waitFor(() => expect(hasIcon(container, status === 'send' ? 'tick.outline' : 'ascent.attempt')).toBe(true));
      expect(hasIcon(container, 'person')).toBe(true);
      expect(
        queryClient.getQueryData<ReadonlySet<string>>(fetchedLogbookClimbUuidsQueryKey('kilter'))?.has('climb-1'),
      ).not.toBe(true);
      expect(controls.readTicks).toHaveBeenCalledTimes(1);
    },
  );

  it('starts the full online batch immediately and replaces local placeholders with a server-empty answer', async () => {
    const server = deferred<{ ticks: LogbookSourceTick[] }>();
    controls.executeHttp.mockReturnValue(server.promise);
    const { container } = renderList();
    expect(controls.executeHttp).toHaveBeenCalledWith(expect.any(String), {
      input: { boardType: 'kilter', climbUuids },
    });
    await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(true));
    const thumbnailCount = controls.thumbnailRender.mock.calls.length;
    await act(async () => {
      server.resolve({ ticks: [] });
    });
    await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(false));
    expect(hasIcon(container, 'person')).toBe(false);
    expect(container.querySelector('[data-variant="title3"]')?.textContent).toBe('V4');
    expect(controls.thumbnailRender).toHaveBeenCalledTimes(thumbnailCount);
  });

  it('wakes when SQLite becomes ready after the list mounted', async () => {
    controls.database = null;
    const { container } = renderList();
    expect(controls.readTicks).not.toHaveBeenCalled();
    act(() => {
      controls.database = {};
      for (const listener of controls.databaseListeners) listener();
    });
    await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(true));
  });

  it('reads a replacement handle while the old handle query is still pending', async () => {
    const oldRead = deferred<LogbookEntry[] | null>();
    const oldHandle = controls.database;
    controls.readTicks.mockImplementation((database: object) =>
      database === oldHandle ? oldRead.promise : Promise.resolve([tick({ status: 'attempt' })]),
    );
    const { container } = renderList();
    await waitFor(() => expect(controls.readTicks).toHaveBeenCalledTimes(1));
    act(() => {
      controls.database = {};
      for (const listener of controls.databaseListeners) listener();
    });
    await waitFor(() => expect(hasIcon(container, 'ascent.attempt')).toBe(true));
    await act(async () => {
      oldRead.resolve([tick()]);
    });
    expect(hasIcon(container, 'tick.outline')).toBe(false);
    expect(controls.readTicks).toHaveBeenCalledTimes(2);
  });

  it('rejects an old account response arriving after a credential change', async () => {
    const oldRead = deferred<LogbookEntry[] | null>();
    controls.readTicks.mockImplementation(
      (_database: object, _board: string, _uuids: readonly string[], viewerId: string) =>
        viewerId === 'user-a' ? oldRead.promise : Promise.resolve([]),
    );
    const { container, rerenderList } = renderList();
    await waitFor(() => expect(controls.readTicks).toHaveBeenCalledTimes(1));
    act(() => {
      controls.viewerId = 'user-b';
      controls.authEpoch += 1;
      controls.credentialScope += 1;
      for (const listener of controls.credentialListeners) listener();
    });
    rerenderList();
    await waitFor(() =>
      expect(controls.readTicks).toHaveBeenCalledWith(controls.database, 'kilter', climbUuids, 'user-b'),
    );
    await act(async () => {
      oldRead.resolve([tick()]);
    });
    expect(hasIcon(container, 'tick.outline')).toBe(false);
    expect(hasIcon(container, 'person')).toBe(false);
  });

  it('refreshes a declined completeness gate when local tick queries are invalidated', async () => {
    controls.complete = false;
    controls.readTicks.mockImplementation(async () => (controls.complete ? [tick()] : null));
    const { container, queryClient } = renderList();
    await waitFor(() => expect(controls.readTicks).toHaveBeenCalledTimes(1));
    expect(hasIcon(container, 'tick.outline')).toBe(false);
    controls.complete = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['localTicks'] });
    });
    await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(true));
  });

  it('restarts a pending declined read when first user sync completes', async () => {
    controls.complete = false;
    const firstRead = deferred<LogbookEntry[] | null>();
    controls.readTicks.mockReturnValueOnce(firstRead.promise).mockResolvedValue([tick()]);
    const { container, queryClient } = renderList();
    await waitFor(() => expect(controls.readTicks).toHaveBeenCalledTimes(1));
    controls.complete = true;
    await act(async () => {
      const refresh = queryClient.invalidateQueries({ queryKey: ['localTicks'] });
      firstRead.resolve(null);
      await refresh;
    });
    await waitFor(() => expect(controls.readTicks).toHaveBeenCalledTimes(2));
    expect(hasIcon(container, 'tick.outline')).toBe(true);
  });

  it('keeps server fetching available when offline mode is disabled', async () => {
    controls.offlineEnabled = false;
    renderList();
    expect(controls.executeHttp).toHaveBeenCalled();
    expect(controls.readIdentity).not.toHaveBeenCalled();
    expect(controls.readTicks).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'enriches an unknown cached revision from local ticks when server coverage is %s',
    async (fetched) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [tick()]);
      if (fetched) queryClient.setQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'), new Set(climbUuids));
      controls.readTicks.mockResolvedValue([tick({ climbRevision: 1 })]);
      const { container } = renderList(queryClient, { ...baseClimb, holdsRevisionNumber: 2 });
      expect(hasIcon(container, 'tick.outline')).toBe(true);
      await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(false));
      expect(hasIcon(container, 'person')).toBe(true);
    },
  );

  it('preserves a known cached revision ahead of a stale local revision', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [tick({ climbRevision: 3 })]);
    controls.readTicks.mockResolvedValue([tick({ climbRevision: 1 })]);
    const { container } = renderList(queryClient, { ...baseClimb, holdsRevisionNumber: 2 });
    await waitFor(() => {
      const batch = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['localTicks', 'list'] })
        .find((query) => query.state.data !== null);
      expect(batch?.state.data).toMatchObject({ entries: [{ climb_revision: 1 }] });
    });
    expect(hasIcon(container, 'tick.outline')).toBe(true);
  });

  it('keeps cached payloads ahead of duplicate local ticks', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [tick({ status: 'attempt', difficulty: 24 })]);
    controls.readTicks.mockResolvedValue([tick({ status: 'send', difficulty: 20 })]);
    const { container } = renderList(queryClient);
    await waitFor(() => {
      const batch = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['localTicks', 'list'] })
        .find((query) => query.state.status === 'success' && query.state.data !== null);
      expect(batch?.state.data).toMatchObject({ entries: [{ status: 'send' }] });
    });
    expect(hasIcon(container, 'ascent.attempt')).toBe(true);
    expect(hasIcon(container, 'tick.outline')).toBe(false);
  });

  it('respects an explicit ungraded search row ahead of the local personal grade', async () => {
    const { container } = renderList(undefined, { ...baseClimb, myDifficulty: null });
    await waitFor(() => expect(hasIcon(container, 'tick.outline')).toBe(true));
    expect(hasIcon(container, 'person')).toBe(false);
    expect(container.querySelector('[data-variant="title3"]')?.textContent).toBe('V4');
  });
});
