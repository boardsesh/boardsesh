// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { createElement, useLayoutEffect, useState, Suspense, StrictMode, startTransition, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb as SchemaClimb } from '@boardsesh/shared-schema';
import type { PlaylistSuggestionSource } from '@boardsesh/queue';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
const ui = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  list: null as Record<string, unknown> | null,
  open: vi.fn(),
  actions: vi.fn(() => []),
  drive: false,
  snapshot: vi.fn<
    () => {
      currentClimbQueueItem: { climb: { uuid: string } } | null;
      playlistSuggestionSource: PlaylistSuggestionSource | null;
    }
  >(() => ({ currentClimbQueueItem: null, playlistSuggestionSource: null })),
  setCurrent: vi.fn(),
  setSource: vi.fn(),
  refresh: vi.fn(() => false),
}));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope }));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => {
    throw new Error('Used latest raw HTTP client');
  },
}));
vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({ useToggleAuthorFollow: vi.fn() }));
vi.mock('../../../lib/graphql/hooks', async () => {
  const actual = await import('../../../lib/graphql/hooks/use-social');
  return { useUserClimbs: actual.useUserClimbs };
});
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => false }));
vi.mock('../../../hooks/use-hide-on-scroll', () => ({ useHideOnScroll: () => undefined }));
vi.mock('../../../hooks/use-scroll-edge-backdrop', () => ({ ScrollEdgeListReset: () => null }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    ui.list = props;
    const rows = props.data as SchemaClimb[];
    const renderItem = props.renderItem as (args: { item: SchemaClimb }) => ReactNode;
    return createElement(
      'div',
      { 'data-list': true },
      rows.map((item) => createElement('div', { key: item.uuid }, renderItem({ item }))),
    );
  },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../ClimbListRow', () => ({
  ClimbListRow: (props: Record<string, unknown>) => {
    ui.rows.push(props);
    return null;
  },
}));
vi.mock('../../../providers/climb-progress-provider', () => ({
  ClimbProgressProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useIsSharedSession: () => false,
  useQueueActions: () => ({
    setCurrentClimb: ui.setCurrent,
    setPlaylistSuggestionSource: ui.setSource,
    refreshPlaylistSuggestionSource: ui.refresh,
    getQueueSnapshot: ui.snapshot,
    setQueue: vi.fn(),
    appendQueueItems: vi.fn(),
  }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: ui.open, getClimbActions: ui.actions }),
}));
vi.mock('../../../providers/queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useChoose: () => vi.fn() }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } }),
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  renderBoardToPlaylistConfig: () => ({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 2] }),
}));
vi.mock('../../../components/play-drawer/use-climb-change-lights', () => ({ isDrivingWall: () => ui.drive }));
vi.mock('../../../settings/hooks', () => ({ getSetting: () => false }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { ProfileClimbsTab } from '../ProfileClimbsTab';
import { useTrackPaging } from '../../play-drawer/use-track-paging';
import {
  _resetTrackPagerForTests,
  canLoadMoreOfTrack,
  registerTrackPageLoader,
  loadNextTrackPage,
  pinTrackLoader,
  releaseUnusedTrackPage,
} from '../../../lib/playlists/track-pager';
import { httpPageSourceDiagnostics } from '../../../lib/graphql/use-http-query';
import * as trackPager from '../../../lib/playlists/track-pager';

const dispose: (() => void)[] = [];
beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
  ui.rows = [];
  ui.list = null;
  ui.drive = false;
  ui.open.mockReset();
  ui.actions.mockClear();
  ui.setCurrent.mockClear();
  ui.setSource.mockClear();
  ui.refresh.mockClear();
  ui.snapshot.mockReset().mockReturnValue({ currentClimbQueueItem: null, playlistSuggestionSource: null });
});
afterEach(() => {
  cleanup();
  _resetTrackPagerForTests();
  for (const close of dispose.splice(0).reverse()) close();
  selected.scope = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function page(target: string, offset: number) {
  return {
    climbs: Array.from({ length: 30 }, (_, index) => ({
      uuid: `${target}-${offset + index}`,
      name: 'Owned climb',
      boardType: 'kilter',
      layoutId: 1,
      angle: 40,
      frames: 'p1r12',
    })),
    hasMore: offset === 0,
  };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: { userId: string; offset: number; limit: number }[] = [];
  http.performFetch.mockImplementation(async (_url, options) => {
    const payload = JSON.parse((options as RequestInit).body as string) as {
      variables?: { input?: { userId: string; offset: number; limit: number } };
    };
    const input = payload.variables?.input;
    if (!input) return Response.json({ data: { freshOwned: true } });
    requests.push(input);
    return Response.json({ data: { userClimbs: page(input.userId, input.offset) } });
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  dispose.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, requests, wrapper };
}
async function screen(current: ReturnType<typeof fixture>, target = 'target-A') {
  const view = render(<ProfileClimbsTab userId={target} />, { wrapper: current.wrapper });
  await waitFor(() => expect((ui.list?.data as SchemaClimb[] | undefined)?.[0]?.uuid).toBe(`${target}-0`));
  return view;
}
function firstRow() {
  return ui.rows.findLast((props) => (props.climb as SchemaClimb).uuid.endsWith('-0'))!;
}
function tap(row = firstRow()) {
  act(() => (row.onPress as (climb: SchemaClimb) => void)(row.climb as SchemaClimb));
}
function openedSource(): PlaylistSuggestionSource {
  const source = ui.open.mock.calls.at(-1)?.[1]?.playlistSuggestionSource as PlaylistSuggestionSource | undefined;
  if (!source) throw new Error('Expected actual list track');
  return source;
}
function paging(source: PlaylistSuggestionSource) {
  let sourceCommits = 0;
  const result = renderHook(() => {
    const [current, setCurrent] = useState<PlaylistSuggestionSource | null>(source);
    useLayoutEffect(() => {
      sourceCommits += 1;
    }, [current]);
    useTrackPaging({
      source: current,
      listClimbUuid: source.climbs.at(-1)!.uuid,
      previewTrack: true,
      setPreviewSource: setCurrent,
      getCommittedSource: () => null,
      refreshCommittedSource: () => false,
    });
    return current;
  });
  return { ...result, commits: () => sourceCommits };
}
function heldResponse(target: string) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: { userClimbs: page(target, 30) } })));
        release = () => controller.close();
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  return { response, release };
}

/** Fixture timing only: schedule the REAL fulfilled hook continuation as one
 * transition. The native Promise result/rejection, SDK, registry and consumers
 * are unchanged; both actual same-fiber state setters execute in that lane. */
function transitionFulfillment<Value>(pending: Promise<Value>): Promise<Value> {
  const ordinaryThen: typeof pending.then = pending.then.bind(pending);
  const scheduledThen: typeof pending.then = function <Success = Value, Failure = never>(
    onFulfilled?: ((result: Value) => Success | PromiseLike<Success>) | null,
    onRejected?: ((reason: unknown) => Failure | PromiseLike<Failure>) | null,
  ): Promise<Success | Failure> {
    return ordinaryThen<Success, Failure>(
      onFulfilled
        ? (result) => {
            let returned!: Success | PromiseLike<Success>;
            let thrown: unknown;
            let failed = false;
            startTransition(() => {
              try {
                returned = onFulfilled(result);
              } catch (error) {
                failed = true;
                thrown = error;
              }
            });
            if (failed) throw thrown;
            return returned;
          }
        : undefined,
      onRejected,
    );
  };
  vi.spyOn(pending, 'then').mockImplementation(scheduledThen);
  return pending;
}

describe('mounted profile original delivery through real track owners', () => {
  it('excludes raw A cache and carries the fixed original target after navigation and origin unmount', async () => {
    const current = fixture();
    current.cache.setQueryData(['userClimbs', 'target-A'], {
      pages: [{ climbs: [{ uuid: 'raw-private-A' }], hasMore: true }],
      pageParams: [0],
    });
    const view = await screen(current);
    expect(ui.rows.some((row) => (row.climb as SchemaClimb).uuid === 'raw-private-A')).toBe(false);
    tap();
    const source = openedSource();
    view.rerender(<ProfileClimbsTab userId="target-B" />);
    await waitFor(() => expect(current.requests.at(-1)?.userId).toBe('target-B'));
    view.unmount();
    expect(canLoadMoreOfTrack(source)).toBe(true);
    const owner = paging(source);
    await waitFor(() => expect(owner.result.current?.climbs).toHaveLength(60));
    expect(current.requests.at(-1)).toEqual({ userId: 'target-A', offset: 30, limit: 30 });
    expect(owner.result.current?.climbs.at(-1)?.uuid).toBe('target-A-59');
    expect(owner.result.current?.continuation).toBeUndefined();
    expect(owner.commits()).toBe(2);
    expect(current.performFetch).toHaveBeenCalledTimes(3);
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
  });

  it.each(['B', 'ABA', 'expiry-fresh-lease'] as const)(
    'holds actual body settlement before React publication across %s',
    async (change) => {
      const current = fixture();
      const view = await screen(current);
      tap();
      const source = openedSource();
      view.unmount();
      const held = heldResponse('target-A');
      current.performFetch.mockResolvedValueOnce(held.response);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const owner = paging(source);
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      if (change === 'expiry-fresh-lease') {
        current.clock(200_000);
        const fresh = current.operations.capture();
        await fresh.request('query FreshOwned { freshOwned }');
        fresh.assertDeliveries();
        fresh.dispose();
      } else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      await act(async () => {
        held.release();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(owner.result.current).toBe(source);
      expect(owner.commits()).toBe(1);
      expect(warning).not.toHaveBeenCalled();
    },
  );

  it('retires old row, menu and end callbacks through target A/B/A before another packet or local action', async () => {
    const current = fixture();
    const view = await screen(current);
    const row = firstRow();
    const end = ui.list!.onEndReached as () => void;
    view.rerender(<ProfileClimbsTab userId="target-B" />);
    await waitFor(() => expect((ui.list?.data as SchemaClimb[] | undefined)?.[0]?.uuid).toBe('target-B-0'));
    view.rerender(<ProfileClimbsTab userId="target-A" />);
    await waitFor(() => expect((ui.list?.data as SchemaClimb[] | undefined)?.[0]?.uuid).toBe('target-A-0'));
    const before = current.performFetch.mock.calls.length;
    tap(row);
    act(() => {
      (row.onOpenActions as (climb: SchemaClimb) => void)(row.climb as SchemaClimb);
      end();
    });
    expect(ui.open).not.toHaveBeenCalled();
    expect(ui.actions).not.toHaveBeenCalled();
    expect(current.performFetch).toHaveBeenCalledTimes(before);
  });

  it('refuses retired original UI callbacks without waiting for a rerender', async () => {
    const current = fixture();
    await screen(current);
    const row = firstRow();
    const end = ui.list!.onEndReached as () => void;
    current.switchAccount('owned-B');
    tap(row);
    act(() => {
      (row.onOpenActions as (climb: SchemaClimb) => void)(row.climb as SchemaClimb);
      end();
    });
    expect(ui.open).not.toHaveBeenCalled();
    expect(ui.actions).not.toHaveBeenCalled();
    expect(current.performFetch).toHaveBeenCalledOnce();
  });

  it('releases the actual end-reach delivery consumer after the page is cached', async () => {
    const current = fixture();
    await screen(current);
    act(() => (ui.list!.onEndReached as () => void)());
    await waitFor(() => expect(ui.list!.data as SchemaClimb[]).toHaveLength(60));
    await waitFor(() =>
      expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
        pendingGroups: 0,
        consumers: 0,
      }),
    );
    expect(current.performFetch).toHaveBeenCalledTimes(2);
  });

  it('opens an already-current driving climb without suppressing its existing put-on-board intent', async () => {
    const current = fixture();
    await screen(current);
    ui.drive = true;
    ui.snapshot.mockReturnValue({
      currentClimbQueueItem: { climb: { uuid: 'target-A-0' } },
      playlistSuggestionSource: null,
    });
    tap();
    await act(async () => {
      await Promise.resolve();
    });
    expect(ui.open).toHaveBeenCalledOnce();
    expect(ui.open.mock.calls[0][1].committedExternally).toBeUndefined();
    expect(ui.setCurrent).not.toHaveBeenCalled();
    expect(ui.setSource).toHaveBeenCalledOnce();
  });

  it('releases both captured initial handles when a retap retires refresh before publication', async () => {
    const current = fixture();
    await screen(current);
    ui.drive = true;
    const row = firstRow();
    await act(async () => {
      (row.onPress as (climb: SchemaClimb) => void)(row.climb as SchemaClimb);
      await Promise.resolve();
      (row.onPress as (climb: SchemaClimb) => void)(row.climb as SchemaClimb);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
        pendingGroups: 0,
        consumers: 0,
      }),
    );
    expect(ui.open).toHaveBeenCalledTimes(2);
    expect(current.performFetch).toHaveBeenCalledOnce();
  });

  it('gives two real waiting owners independent consumers while one unmounts', async () => {
    const current = fixture();
    const view = await screen(current);
    tap();
    const source = openedSource();
    view.unmount();
    const held = heldResponse('target-A');
    current.performFetch.mockResolvedValueOnce(held.response);
    const first = paging(source);
    const second = paging(source);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    first.unmount();
    await act(async () => {
      held.release();
    });
    await waitFor(() => expect(second.result.current?.climbs).toHaveLength(60));
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
    expect(current.performFetch).toHaveBeenCalledTimes(2);
  });

  it('retires an unpinned fixed observer on registry eviction without cancelling another source', async () => {
    const current = fixture();
    const view = await screen(current);
    tap();
    const source = openedSource();
    tap();
    const surviving = openedSource();
    pinTrackLoader('preview', surviving);
    view.unmount();
    for (let index = 0; index < 40; index += 1) registerTrackPageLoader(async () => null);
    expect(canLoadMoreOfTrack(source)).toBe(false);
    expect(await loadNextTrackPage(source)).toBeNull();
    expect(canLoadMoreOfTrack(surviving)).toBe(true);
    const delivered = await loadNextTrackPage(surviving);
    expect(delivered?.climbs).toHaveLength(30);
    if (delivered) releaseUnusedTrackPage(delivered);
    expect(current.requests.at(-1)).toEqual({ userId: 'target-A', offset: 30, limit: 30 });
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
  });

  it.each(['opening', 'dispatch'] as const)(
    'checks the captured source after the %s queue snapshot and before local dispatch',
    async (phase) => {
      const current = fixture();
      await screen(current);
      ui.drive = true;
      if (phase === 'dispatch')
        ui.snapshot.mockReturnValueOnce({ currentClimbQueueItem: null, playlistSuggestionSource: null });
      ui.snapshot.mockImplementationOnce(() => {
        current.switchAccount('owned-B');
        return { currentClimbQueueItem: null, playlistSuggestionSource: null };
      });
      tap();
      await act(async () => {
        await Promise.resolve();
      });
      expect(ui.snapshot).toHaveBeenCalledTimes(phase === 'dispatch' ? 2 : 1);
      expect(ui.open).toHaveBeenCalledTimes(phase === 'dispatch' ? 1 : 0);
      expect(ui.setCurrent).not.toHaveBeenCalled();
      expect(ui.setSource).not.toHaveBeenCalled();
    },
  );
  it.each(['current-replay', 'expired-original-replay'] as const)(
    'guards the real adopted preview updater after an observed suspended attempt: %s',
    async (phase) => {
      const current = fixture();
      const view = await screen(current);
      tap();
      const original = openedSource();
      view.unmount();
      const held = heldResponse('target-A');
      current.performFetch.mockResolvedValueOnce(held.response);
      const originalLoad = trackPager.loadNextTrackPage;
      vi.spyOn(trackPager, 'loadNextTrackPage').mockImplementation((source) => {
        const real = originalLoad(source);
        return source === original ? transitionFulfillment(real) : real;
      });
      let blocked = true;
      let release!: () => void;
      const suspended = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attemptedRows: number[] = [];
      const committedSources: (PlaylistSuggestionSource | null)[] = [];
      function PendingPreview({ source }: { source: PlaylistSuggestionSource | null }) {
        if (source?.climbs.length === 60) {
          attemptedRows.push(source.climbs.length);
          if (blocked) throw suspended;
        }
        return <span data-preview-count={source?.climbs.length} />;
      }
      function PreviewOwner() {
        const [source, setSource] = useState<PlaylistSuggestionSource | null>(original);
        useTrackPaging({
          source,
          listClimbUuid: original.climbs.at(-1)!.uuid,
          previewTrack: true,
          setPreviewSource: setSource,
          getCommittedSource: () => null,
          refreshCommittedSource: () => false,
        });
        useLayoutEffect(() => {
          committedSources.push(source);
        }, [source]);
        return <PendingPreview source={source} />;
      }
      render(
        <Suspense fallback={<span data-preview-fallback />}>
          <PreviewOwner />
        </Suspense>,
      );
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      await act(async () => {
        held.release();
        await Promise.resolve();
      });
      await waitFor(() => expect(attemptedRows.length).toBeGreaterThan(0));
      expect(committedSources).toEqual([original]);
      expect(document.querySelector('[data-preview-count]')?.getAttribute('data-preview-count')).toBe('30');
      expect(document.querySelector('[data-preview-fallback]')).toBeNull();
      expect(
        httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A'])).consumers,
      ).toBeGreaterThan(0);
      // Renew while the first120s lease remains live; this actual operation has
      // its own later220s deadline and must not revive the original page cause.
      current.clock(100_000);
      const fresh = current.operations.capture({ mode: 'offline' });
      await fresh.request('query FreshOwned { freshOwned }');
      fresh.assertDeliveries();
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      current.clock(phase === 'current-replay' ? 110_000 : 130_000);
      fresh.assertDeliveries();
      await act(async () => {
        blocked = false;
        release();
        await suspended;
      });
      await waitFor(() =>
        expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
          pendingGroups: 0,
          consumers: 0,
        }),
      );
      const expected = phase === 'current-replay' ? 60 : 30;
      expect(document.querySelector('[data-preview-count]')?.getAttribute('data-preview-count')).toBe(String(expected));
      expect(committedSources.at(-1)?.climbs).toHaveLength(expected);
      if (phase === 'expired-original-replay') expect(committedSources).toEqual([original]);
      else expect(committedSources).toHaveLength(2);
      expect(current.performFetch).toHaveBeenCalledTimes(3);
      fresh.assertDeliveries();
      fresh.dispose();
    },
  );

  it('retires the old StrictMode waiter while the re-setup owner and a later mount stay live', async () => {
    const current = fixture();
    const view = await screen(current);
    tap();
    const original = openedSource();
    view.unmount();
    const held = heldResponse('target-A');
    current.performFetch.mockResolvedValueOnce(held.response);
    const publications: ReturnType<typeof trackPager.createTrackPublication>[] = [];
    const settlements: { index: number; outcome: string }[] = [];
    const originalCreate = trackPager.createTrackPublication;
    vi.spyOn(trackPager, 'createTrackPublication').mockImplementation(
      (expected, consumer, assertOwner, options = {}) => {
        const index = publications.length;
        // Observe the actual publication's settlement; never replace its guard,
        // receipt, claim, updater or provider/preview setter.
        const publication = originalCreate(expected, consumer, assertOwner, {
          ...options,
          onSettled: (outcome) => {
            settlements.push({ index, outcome });
            options.onSettled?.(outcome);
          },
        });
        publications.push(publication);
        return publication;
      },
    );
    let setups = 0;
    let cleanups = 0;
    const committed: (PlaylistSuggestionSource | null)[] = [];
    function StrictPreviewOwner() {
      const [source, setSource] = useState<PlaylistSuggestionSource | null>(original);
      useLayoutEffect(() => {
        setups += 1;
        return () => {
          cleanups += 1;
        };
      }, []);
      useTrackPaging({
        source,
        listClimbUuid: original.climbs.at(-1)!.uuid,
        previewTrack: true,
        setPreviewSource: setSource,
        getCommittedSource: () => null,
        refreshCommittedSource: () => false,
      });
      useLayoutEffect(() => {
        committed.push(source);
      }, [source]);
      return <span data-strict-preview-count={source?.climbs.length} />;
    }
    const firstOwner = render(
      <StrictMode>
        <StrictPreviewOwner />
      </StrictMode>,
    );
    expect(setups).toBe(2);
    expect(cleanups).toBe(1);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    expect((current.performFetch.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(false);
    await act(async () => {
      held.release();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.querySelector('[data-strict-preview-count]')?.getAttribute('data-strict-preview-count')).toBe(
        '60',
      ),
    );
    await waitFor(() =>
      expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
        pendingGroups: 0,
        consumers: 0,
      }),
    );
    expect(settlements).toEqual([
      { index: 0, outcome: 'retired' },
      { index: 1, outcome: 'applied' },
    ]);
    expect(committed.filter((source) => source?.climbs.length === 60)).toHaveLength(1);
    expect(() => publications[0].assertCurrent()).toThrow();
    expect(() => publications[1].assertCurrent()).not.toThrow();
    firstOwner.unmount();
    expect(cleanups).toBe(2);
    expect(() => publications[1].assertCurrent()).toThrow();
    const secondOwner = render(
      <StrictMode>
        <StrictPreviewOwner />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-strict-preview-count]')?.getAttribute('data-strict-preview-count')).toBe(
        '60',
      ),
    );
    expect(setups).toBe(4);
    expect(cleanups).toBe(3);
    expect(settlements.slice(2)).toEqual([
      { index: 2, outcome: 'retired' },
      { index: 3, outcome: 'applied' },
    ]);
    expect(() => publications[0].assertCurrent()).toThrow();
    expect(() => publications[1].assertCurrent()).toThrow();
    expect(() => publications[3].assertCurrent()).not.toThrow();
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'target-A']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
    secondOwner.unmount();
    expect(cleanups).toBe(4);
    expect(() => publications[3].assertCurrent()).toThrow();
  });
});
