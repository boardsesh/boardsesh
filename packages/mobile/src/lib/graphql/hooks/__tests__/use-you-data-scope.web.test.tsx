// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { Fragment, StrictMode, Suspense, startTransition, type ReactNode } from 'react';
// Load the real DOM scheduler; this retained graph has no react-dom typings.
const { flushSync } = await vi.importActual<{ flushSync: (commit: () => void) => void }>('react-dom');
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_TYPES } from '@boardsesh/profile-stats';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { HttpQueryScope } from '../../http-query-scope';
import type { HttpOperationOptions } from '../../http-operation';
import type { createScopedHttpFixture } from '../../__tests__/fixtures/scoped-http';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  http: null as ReturnType<typeof createScopedHttpFixture> | null,
  focused: true,
  refresh: undefined as (() => void) | undefined,
  retry: undefined as (() => void) | undefined,
  schedule: null as ((invoke: () => unknown, argumentsList: unknown[]) => unknown) | null,
}));
vi.mock('../../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing actual owned HTTP query scope');
    return selected.scope;
  },
}));
vi.mock('../../http-operation', () => ({
  createHttpOperation: (scope: string | undefined, options?: HttpOperationOptions) => {
    if (!selected.http) throw new Error('Missing actual original-delivery operations');
    const original = selected.http.operations.create(scope, options);
    const schedule = selected.schedule;
    if (!schedule) return original;
    // Timing fixture only: each invocation still enters the same real original
    // operation's actual request/SDK admission. No guard or receipt is replaced.
    const request = new Proxy(original.request, {
      apply(target, receiver, argumentsList) {
        return schedule(() => Reflect.apply(target, receiver, argumentsList), argumentsList);
      },
    });
    return { ...original, request };
  },
}));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    throw new Error('Finite selected read used latest raw client');
  },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => selected.focused }));
vi.mock('../../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../../connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, reason: null }),
}));

// DOM leaves replace platform drawing only. ProgressView, ProfileBoardOverview,
// OfflineStateView, the composing hook, QueryClient, SDK and lease guards are real.
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children);
  return {
    View,
    Text: View,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => {
      selected.refresh = onRefresh;
      return createElement('button', { 'data-testid': 'actual-refresh-control', onClick: onRefresh }, 'refresh');
    },
    Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
  };
});
vi.mock('@shopify/flash-list', async () => {
  const { createElement, Fragment } = await import('react');
  return {
    FlashList: ({
      data,
      renderItem,
      refreshControl,
      testID,
    }: {
      data: unknown[];
      renderItem: (options: { item: unknown }) => ReactNode;
      refreshControl?: ReactNode;
      testID?: string;
    }) =>
      createElement(
        'div',
        { 'data-testid': testID },
        refreshControl,
        data.map((item, index) => createElement(Fragment, { key: index }, renderItem({ item }))),
      ),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: 'black', secondaryLabel: 'gray', tertiaryLabel: 'gray', fill: 'gray', accent: 'blue' },
    brandColors: { primary: 'blue' },
    colorScheme: 'light',
    textStyles: { largeTitle: { lineHeight: 32 } },
  }),
}));
vi.mock('../../../../theme/variants', () => ({
  useVariantValue: (options: { material: unknown }) => options.material,
}));
vi.mock('../../../../hooks/use-scroll-edge-backdrop', () => ({ ScrollEdgeListReset: () => null }));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../../components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => {
    if (testID === 'profile-board-overview-retry') selected.retry = onPress;
    return (
      <button data-testid={testID} onClick={onPress}>
        {children}
      </button>
    );
  },
}));
vi.mock('../../../../components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) => {
    selected.retry = onPress;
    return (
      <button data-testid="actual-offline-retry" onClick={onPress}>
        {title}
      </button>
    );
  },
}));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../components/ActivityIndicator', () => ({ ActivityIndicator: () => <span>loading</span> }));
vi.mock('../../../../components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/ContentRenderObserver', () => ({ ContentRenderMarker: () => null }));
vi.mock('../../../../components/SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../../../components/onboarding/OnboardingTipBanner', () => ({ OnboardingTipBanner: () => null }));
vi.mock('../../../../components/you/ActivityHeatmap', () => ({ ActivityHeatmap: () => null }));
vi.mock('../../../../components/you/PeriodComparisonCard', () => ({ PeriodComparisonCard: () => null }));
vi.mock('../../../../components/you/StatsSummaryCard', () => ({ StatsSummaryCard: () => null }));
vi.mock('../../../../components/you/YouCharts', () => ({
  GroupedBarChart: () => null,
  StackedBarChart: () => null,
  TotalAreaChart: () => null,
}));

import { GraphQLClient } from 'graphql-request';
import { createBrowserHttpClientFacade } from '../../http-client-facade.web';
import { createBrowserHttpOperations } from '../../http-operation-client.web';
import { createHttpQueryScope } from '../../http-query-scope';
import { createScopedHttpFixture as createHttpFixture } from '../../__tests__/fixtures/scoped-http';
import {
  useAllBoardsTicks,
  useUserTickCountsByBoard,
  useUserProfileStats,
  useUserClimbPercentile,
} from '../use-you-data';
import { useYouProfileData } from '../use-you-profile-data';
import { ProgressView } from '../../../../components/you/ProgressView';

type Packet = { query: string; variables: { userId?: string; boardType?: string } };
const close: (() => void)[] = [];
afterEach(() => {
  onlineManager.setOnline(true);
  cleanup();
  close
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  selected.scope = null;
  selected.http = null;
  selected.focused = true;
  selected.refresh = undefined;
  selected.retry = undefined;
  selected.schedule = null;
});
function fixture() {
  const http = createHttpFixture();
  selected.http = http;
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const packets: Packet[] = [];
  http.performFetch.mockImplementation(async (_url, options) => {
    const packet = JSON.parse((options as RequestInit).body as string) as Packet;
    packets.push(packet);
    return reply(packet);
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  close.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper, packets };
}
function reply(packet: Packet, total = 7) {
  if (packet.query.includes('GetUserTickCountsByBoard'))
    return Response.json({ data: { userTickCountsByBoard: [{ boardType: 'kilter', count: total }] } });
  if (packet.query.includes('GetUserProfileStats'))
    return Response.json({ data: { userProfileStats: { totalDistinctClimbs: total, layoutStats: [] } } });
  if (packet.query.includes('GetUserClimbPercentile'))
    return Response.json({
      data: { userClimbPercentile: { totalDistinctClimbs: total, percentile: 80, totalActiveUsers: 100 } },
    });
  return Response.json({ data: { userTicks: [] } });
}
function heldBody(payload: unknown, status = 200) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        release = () => controller.close();
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
  return { response, release };
}
function useFour(target: string | undefined, onScreen = true) {
  return {
    ticks: useAllBoardsTicks(target, { onScreen }),
    counts: useUserTickCountsByBoard(target),
    stats: useUserProfileStats(target, { onScreen }),
    percentile: useUserClimbPercentile(target, { onScreen }),
  };
}
function Progress({ target }: { target: string }) {
  const profile = useYouProfileData(target);
  return (
    <Fragment>
      <output data-testid="selected-timeframe">{profile.timeframe}</output>
      <ProgressView data={profile} topInset={0} bottomInset={0} nativeRootHeader={false} listTopOffset={0} />
    </Fragment>
  );
}
async function freshLease(current: ReturnType<typeof fixture>) {
  const operation = current.operations.capture();
  await operation.request('query FreshIndependent { viewer { id } }');
  operation.assertDeliveries();
  close.push(() => operation.dispose());
  return operation;
}

describe('finite You original SDK deliveries', () => {
  it('uses one captured viewer, separate public target, scoped keys and actual four SDK results', async () => {
    const current = fixture();
    current.cache.setQueryData(['userProfileStats', 'public-target'], { totalDistinctClimbs: 999, layoutStats: [] });
    const screen = renderHook(() => useFour('public-target'), { wrapper: current.wrapper });
    expect(screen.result.current.stats.data).toBeUndefined();
    await waitFor(() => expect(Object.values(screen.result.current).every((query) => query.isSuccess)).toBe(true));
    expect(screen.result.current.stats.data!.totalDistinctClimbs).toBe(7);
    expect(screen.result.current.counts.data).toEqual({ kilter: 7 });
    expect(current.packets).toHaveLength(BOARD_TYPES.length + 3);
    expect(current.packets.every((packet) => packet.variables.userId === 'public-target')).toBe(true);
    expect(current.issueLease).toHaveBeenCalledOnce();
    const keys = current.cache
      .getQueryCache()
      .findAll()
      .map((query) => query.queryKey);
    expect(keys.filter((key) => key[0] === 'browser-view')).toHaveLength(4);
    expect(current.cache.getQueryData(['userProfileStats', 'public-target'])).toEqual({
      totalDistinctClimbs: 999,
      layoutStats: [],
    });
  });

  it.each(['B', 'ABA', 'generation', 'expiry-with-fresh-lease'] as const)(
    'refuses a held actual body after %s',
    async (change) => {
      const current = fixture();
      const body = heldBody({ data: { userProfileStats: { totalDistinctClimbs: 91, layoutStats: [] } } });
      current.performFetch.mockResolvedValueOnce(body.response);
      const screen = renderHook(() => useUserProfileStats('public-target'), { wrapper: current.wrapper });
      const originalKey = selected.scope!.key(['userProfileStats', 'public-target']);
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      if (change === 'expiry-with-fresh-lease') {
        current.clock(100_000);
        const fresh = await freshLease(current);
        current.clock(130_000);
        expect(() => fresh.assertDeliveries()).not.toThrow();
      } else if (change === 'generation') current.nextGeneration();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      body.release();
      await waitFor(() => expect(screen.result.current.fetchStatus).toBe('idle'));
      expect(current.cache.getQueryData(originalKey)).toBeUndefined();
      expect(screen.result.current.data).toBeUndefined();
    },
  );

  it('does not send unknown-user reads or expose old raw/scoped A cache in a disabled B view', async () => {
    const current = fixture();
    const screen = renderHook(({ target }) => useFour(target), {
      wrapper: current.wrapper,
      initialProps: { target: 'public-target' as string | undefined },
    });
    await waitFor(() => expect(screen.result.current.stats.isSuccess).toBe(true));
    current.switchAccount('owned-B');
    selected.scope = current.scope();
    screen.rerender({ target: undefined });
    expect(Object.values(screen.result.current).every((query) => query.data === undefined)).toBe(true);
    expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length + 3);
  });

  it('admits confirmed anonymous public reads without requesting a private lease', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    const screen = renderHook(() => useFour('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(screen.result.current.stats.isSuccess).toBe(true));
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.packets).toHaveLength(BOARD_TYPES.length + 3);
  });

  it('forces a real fixed-key SDK refetch despite a fresh 30-minute cache and retains observer result shape', async () => {
    const current = fixture();
    const screen = renderHook(() => useUserProfileStats('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    let observed: Awaited<ReturnType<typeof screen.result.current.refetchOriginal>> | undefined;
    await act(async () => {
      observed = await screen.result.current.refetchOriginal();
    });
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(observed).toMatchObject({ status: 'success', fetchStatus: 'idle', data: { totalDistinctClimbs: 7 } });
  });

  it('waits every physical fanout body and preserves the chronological first actual ClientError', async () => {
    const current = fixture();
    const slow = heldBody({ errors: [{ message: 'later-first-board' }] });
    const first = heldBody({ errors: [{ message: 'chronological-first' }] });
    const last = heldBody({ data: { userTicks: [] } });
    let position = 0;
    current.performFetch.mockImplementation(
      async () =>
        [slow.response, first.response, last.response][position++] ?? Response.json({ data: { userTicks: [] } }),
    );
    const screen = renderHook(() => useAllBoardsTicks('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length));
    first.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.result.current.fetchStatus).toBe('fetching');
    expect(screen.result.current.error).toBeNull();
    slow.release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.result.current.fetchStatus).toBe('fetching');
    last.release();
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error).toMatchObject({ response: { errors: [{ message: 'chronological-first' }] } });
    expect(screen.result.current.data).toBeUndefined();
  });

  it.each(['error-only', 'mixed-partial'] as const)(
    'refuses original error qualification after first cause expiry with a fresh lease (%s)',
    async (kind) => {
      const current = fixture();
      const held = heldBody(
        kind === 'mixed-partial'
          ? { data: { userTicks: [] }, errors: [{ message: 'partial' }] }
          : { errors: [{ message: 'owned-failure' }] },
      );
      current.performFetch.mockImplementation(async () => held.response);
      // Every physical member gets its own original Response; only the first is held.
      current.performFetch.mockImplementationOnce(async () => held.response);
      current.performFetch.mockImplementation(async (_url, options) => {
        const packet = JSON.parse((options as RequestInit).body as string) as Packet;
        if (packet.query.includes('FreshIndependent')) return Response.json({ data: { viewer: { id: 'owned-A' } } });
        return Response.json(
          kind === 'error-only' ? { errors: [{ message: 'other-owned-failure' }] } : { data: { userTicks: [] } },
        );
      });
      const screen = renderHook(() => useAllBoardsTicks('public-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length));
      current.clock(100_000);
      const fresh = await freshLease(current);
      current.clock(130_000);
      expect(() => fresh.assertDeliveries()).not.toThrow();
      held.release();
      await waitFor(() => expect(screen.result.current.isError).toBe(true));
      expect(screen.result.current.error).not.toHaveProperty('response.errors');
      expect(screen.result.current.data).toBeUndefined();
    },
  );

  it('holds unknown fetch failure after all physical members settle without accepting its arbitrary error', async () => {
    const current = fixture();
    const unknown = new Error('owned unknown transport');
    const held = heldBody({ data: { userTicks: [] } });
    current.performFetch.mockRejectedValueOnce(unknown).mockResolvedValueOnce(held.response);
    const screen = renderHook(() => useAllBoardsTicks('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.result.current.isError).toBe(false);
    held.release();
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error).not.toBe(unknown);
    expect(screen.result.current.data).toBeUndefined();
  });
  it('refuses an earlier authentic SDK error after a later physical member fails without provenance', async () => {
    const current = fixture();
    let rejectLate!: (failure: Error) => void;
    const late = new Promise<Response>((_resolve, reject) => {
      rejectLate = reject;
    });
    current.performFetch
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'first authentic error' }] }))
      .mockImplementationOnce(() => late);
    const screen = renderHook(() => useAllBoardsTicks('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.result.current.fetchStatus).toBe('fetching');
    rejectLate(new Error('later unknown transport'));
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error).not.toHaveProperty('response.errors');
    expect(screen.result.current.data).toBeUndefined();
  });

  it.each(['success', 'authentic-error'] as const)(
    'retains early E1 cause after later real E2 members admit (%s)',
    async (firstKind) => {
      const current = fixture();
      let releaseMembers!: () => void;
      const laterMembers = new Promise<void>((resolve) => {
        releaseMembers = resolve;
      });
      const finalBody = heldBody({ data: { userTicks: [] } });
      const admitted: number[] = [];
      const rejected: unknown[] = [];
      const requestTimes: number[] = [];
      let now = 0;
      let position = 0;
      let physical = 0;
      selected.schedule = (invoke) => {
        const member = position++;
        const executeActual = async () => {
          requestTimes.push(now);
          try {
            const result = await invoke();
            admitted.push(member);
            return result;
          } catch (error) {
            rejected.push(error);
            throw error;
          }
        };
        return member === 0 ? executeActual() : laterMembers.then(executeActual);
      };
      current.performFetch.mockImplementation(async () => {
        const member = physical++;
        if (member === 0 && firstKind === 'authentic-error')
          return Response.json({ errors: [{ message: 'early E1 authentic SDK error' }] });
        return member === BOARD_TYPES.length - 1 ? finalBody.response : Response.json({ data: { userTicks: [] } });
      });
      const screen = renderHook(() => useAllBoardsTicks('public-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(admitted.length + rejected.length).toBe(1));
      expect(current.performFetch).toHaveBeenCalledOnce();
      expect(current.issueLease).toHaveBeenCalledOnce();
      expect(screen.result.current.fetchStatus).toBe('fetching');
      now = 100_000;
      current.clock(now);
      releaseMembers();
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(BOARD_TYPES.length));
      await waitFor(() => expect(admitted.length + rejected.length).toBe(BOARD_TYPES.length - 1));
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      expect(requestTimes).toEqual([0, ...BOARD_TYPES.slice(1).map(() => 100_000)]);
      now = 130_000;
      current.clock(now);
      finalBody.release();
      await waitFor(() => expect(screen.result.current.fetchStatus).toBe('idle'));
      // All later E2 SDK requests really admitted while only the retained E1
      // cause expired; per-request admission cannot explain this aggregate hold.
      expect(admitted).toHaveLength(BOARD_TYPES.length - (firstKind === 'success' ? 0 : 1));
      expect(rejected).toHaveLength(firstKind === 'success' ? 0 : 1);
      expect(current.cache.getQueryData(selected.scope!.key(['userTicks', 'public-target']))).toBeUndefined();
      expect(screen.result.current.data).toBeUndefined();
      expect(screen.result.current.isError).toBe(true);
      if (firstKind === 'authentic-error') {
        expect(rejected[0]).toMatchObject({ response: { errors: [{ message: 'early E1 authentic SDK error' }] } });
        expect(screen.result.current.error).not.toBe(rejected[0]);
      }
      expect(screen.result.current.error).not.toHaveProperty('response.errors');
    },
  );

  it('keeps required-selection-unavailable reads empty and sends no SDK packet', async () => {
    const current = fixture();
    expect(() =>
      current.backend.acceptSession({ user: { id: 'owned-A' }, expires: '2099-01-01T00:00:00.000Z' }),
    ).toThrow('unavailable');
    selected.scope = current.scope();
    const screen = renderHook(() => useFour('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(current.cache.isFetching()).toBe(0));
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(Object.values(screen.result.current).every((query) => query.data === undefined)).toBe(true);
  });

  it.each(['SID', 'version'] as const)(
    'refuses original held delivery when the manager selection changes %s',
    async (change) => {
      const current = fixture();
      const held = heldBody({ data: { userProfileStats: { totalDistinctClimbs: 99, layoutStats: [] } } });
      current.performFetch.mockResolvedValueOnce(held.response);
      const screen = renderHook(() => useUserProfileStats('public-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      const next = {
        userId: 'owned-A',
        authSessionId: change === 'SID' ? 'owned-new-SID' : 'owned-SID-A',
        generation: 1,
        cursor: { bindingId: 'a'.repeat(64), version: change === 'version' ? 3 : 2 },
      };
      current.backend.acceptSession({
        user: { id: next.userId },
        authSessionId: next.authSessionId,
        authGeneration: next.generation,
        browserSelection: next,
        expires: '2099-01-01T00:00:00.000Z',
      });
      held.release();
      await waitFor(() => expect(screen.result.current.fetchStatus).toBe('idle'));
      expect(screen.result.current.data).toBeUndefined();
    },
  );

  it('rejects partial execution data rather than showing a successful finite total', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async () =>
      Response.json({
        data: { userProfileStats: { totalDistinctClimbs: 99, layoutStats: [] } },
        errors: [{ message: 'partial execution' }],
      }),
    );
    const screen = renderHook(() => useUserProfileStats('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(screen.result.current.error).toMatchObject({ response: { errors: [{ message: 'partial execution' }] } });
    expect(screen.result.current.data).toBeUndefined();
    expect(current.performFetch).toHaveBeenCalledOnce();
  });
  it('keeps actual wholly legacy SDK body completion and raw cache after unmount without consuming query cancellation', async () => {
    const current = fixture();
    const legacyBackend = createBrowserBackendClient({
      ready: () => false,
      endpoint: '/owned-unused-lease',
      now: () => 0,
      schedule: () => () => {},
      fetch: async () => {
        throw new Error('Legacy must not acquire a lease');
      },
    });
    legacyBackend.acceptSession({ user: { id: 'legacy-viewer' } });
    close.push(() => legacyBackend.dispose());
    const held = heldBody({ data: { userProfileStats: { totalDistinctClimbs: 13, layoutStats: [] } } });
    let actualSignal: AbortSignal | null | undefined;
    const physical = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      actualSignal = options?.signal;
      return held.response;
    });
    const legacy = new GraphQLClient('https://owned-legacy.test/graphql', { fetch: physical });
    const facade = createBrowserHttpClientFacade({
      backendClient: legacyBackend,
      captureGeneration: () => 0,
      isGenerationCurrent: () => true,
      captureIdentity: () => null,
      confirmedAnonymous: () => false,
      required: () => false,
      namespace: () => 'owned-legacy',
      url: 'https://owned-legacy.test/graphql',
      fetch: physical,
      legacyFetch: physical,
      timeoutMs: () => 20_000,
      clientIdentity: () => 'owned-legacy',
      legacy: { get: () => legacy, reset: () => {} },
    });
    const operations = createBrowserHttpOperations({
      captureScope: facade.captureRequestView,
      isCurrentView: facade.isCurrentView,
      captureResult: facade.captureResult,
      captureErrorDelivery: facade.captureErrorDelivery,
      resolveClient: (scope) => facade.getHttpClient(scope),
    });
    selected.http = { ...current, operations };
    selected.scope = createHttpQueryScope({
      scope: undefined,
      scoped: false,
      prefix: [],
      isCurrentView: facade.isCurrentView,
      createOperation: operations.capture,
    });
    close.push(() => facade.dispose());
    const screen = renderHook(() => useUserProfileStats('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(physical).toHaveBeenCalledOnce());
    expect(actualSignal?.aborted).toBe(false);
    screen.unmount();
    expect(actualSignal?.aborted).toBe(false);
    held.release();
    await waitFor(() =>
      expect(current.cache.getQueryData(['userProfileStats', 'public-target'])).toEqual({
        totalDistinctClimbs: 13,
        layoutStats: [],
      }),
    );
    expect(current.issueLease).not.toHaveBeenCalled();
  });
});

describe('real Progress retry, refresh and original UI intent', () => {
  it('retries actual ProfileBoardOverview totals and actual RefreshControl through original SDK queries', async () => {
    const current = fixture();
    let failStats = true;
    current.performFetch.mockImplementation(async (_url, options) => {
      const packet = JSON.parse((options as RequestInit).body as string) as Packet;
      current.packets.push(packet);
      return packet.query.includes('GetUserProfileStats') && failStats
        ? Response.json({ errors: [{ message: 'owned totals error' }] })
        : reply(packet);
    });
    const screen = render(<Progress target="public-target" />, { wrapper: current.wrapper });
    await waitFor(() => expect(screen.getByTestId('profile-board-overview-retry')).toBeTruthy());
    const originalRetry = selected.retry!;
    failStats = false;
    fireEvent.click(screen.getByTestId('profile-board-overview-retry'));
    await waitFor(() => expect(screen.queryByTestId('profile-board-overview-error')).toBeNull());
    expect(current.packets.filter((packet) => packet.query.includes('GetUserProfileStats'))).toHaveLength(2);
    const count = current.packets.length;
    fireEvent.click(screen.getByTestId('actual-refresh-control'));
    await waitFor(() => expect(current.packets).toHaveLength(count + BOARD_TYPES.length + 2));
    expect(originalRetry).toBeTypeOf('function');
  });

  it.each(['target-ABA', 'unmount'] as const)(
    'refuses retained actual retry and RefreshControl callbacks after %s with an unchanged valid viewer lease',
    async (retire) => {
      const current = fixture();
      current.performFetch.mockImplementation(async (_url, options) => {
        const packet = JSON.parse((options as RequestInit).body as string) as Packet;
        return packet.query.includes('GetUserProfileStats')
          ? Response.json({ errors: [{ message: 'owned totals retry' }] })
          : reply(packet);
      });
      const screen = render(<Progress target="public-target" />, { wrapper: current.wrapper });
      await waitFor(() => expect(screen.getByTestId('profile-board-overview-retry')).toBeTruthy());
      const retry = selected.retry!;
      const refresh = selected.refresh!;
      const before = current.performFetch.mock.calls.length;
      if (retire === 'target-ABA') {
        screen.rerender(<Progress target="other-target" />);
        screen.rerender(<Progress target="public-target" />);
      } else screen.unmount();
      await waitFor(() => expect(current.cache.isFetching()).toBe(0));
      const afterAutomatic = current.performFetch.mock.calls.length;
      act(() => {
        retry();
        refresh();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(current.performFetch).toHaveBeenCalledTimes(afterAutomatic);
      expect(afterAutomatic).toBeGreaterThanOrEqual(before);
      expect(current.issueLease).toHaveBeenCalledOnce();
    },
  );

  it.each(['fetch-target-ABA', 'fetch-unmount', 'added-target-ABA'] as const)(
    'blocks the SDK at the actual QueryCache %s reentrant dispatch boundary',
    async (boundary) => {
      const current = fixture();
      const screen = render(<Progress target="public-target" />, { wrapper: current.wrapper });
      await waitFor(() => expect(screen.getByTestId('actual-refresh-control')).toBeTruthy());
      const refresh = selected.refresh!;
      const key = selected.scope!.key(['userTicks', 'public-target']);
      if (boundary.startsWith('added')) current.cache.removeQueries({ queryKey: key, exact: true });
      let retired = false;
      const unsubscribe = current.cache.getQueryCache().subscribe((event) => {
        if (retired || event.query.queryKey.at(-2) !== 'userTicks') return;
        if (
          (boundary.startsWith('added') && event.type === 'added') ||
          (event.type === 'updated' && event.action.type === 'fetch')
        ) {
          retired = true;
          selected.focused = false;
          if (boundary.endsWith('unmount')) screen.unmount();
          else {
            flushSync(() => screen.rerender(<Progress target="other-target" />));
            flushSync(() => screen.rerender(<Progress target="public-target" />));
          }
        }
      });
      const before = current.performFetch.mock.calls.length;
      act(() => refresh());
      await waitFor(() => expect(retired).toBe(true));
      await waitFor(() => expect(current.cache.isFetching()).toBe(0));
      unsubscribe();
      // A target change may start its own automatic queries; none may be the
      // retired fixed original retry. Disable target auto fetch at this boundary.
      expect(current.performFetch.mock.calls.length - before).toBe(0);
    },
  );

  it('uses the actual OfflineStateView retry port and consumes retirement of a held original event promise', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async () =>
      Response.json({ errors: [{ message: 'owned complete outage' }] }),
    );
    const screen = render(<Progress target="public-target" />, { wrapper: current.wrapper });
    await waitFor(() => expect(screen.getByTestId('actual-offline-retry')).toBeTruthy());
    const held = heldBody({ data: { userTicks: [] } });
    current.performFetch.mockImplementation(async (_url, options) =>
      reply(JSON.parse((options as RequestInit).body as string) as Packet),
    );
    current.performFetch.mockResolvedValueOnce(held.response);
    fireEvent.click(screen.getByTestId('actual-offline-retry'));
    await waitFor(() => expect(current.cache.isFetching()).toBeGreaterThan(0));
    screen.unmount();
    held.release();
    await waitFor(() => expect(current.cache.isFetching()).toBe(0));
    expect(current.issueLease).toHaveBeenCalledOnce();
  });
  it('replays the real queued filter reducer against original target identity and preserves the current owner', async () => {
    const current = fixture();
    let profile!: ReturnType<typeof useYouProfileData>;
    let blocked = true;
    let attempted = false;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    function Pending({ timeframe }: { timeframe: string }) {
      if (blocked && timeframe === 'lastWeek') {
        attempted = true;
        throw gate;
      }
      return null;
    }
    function Owner({ target }: { target: string }) {
      profile = useYouProfileData(target);
      return (
        <>
          <output data-testid="committed-filter">{profile.timeframe}</output>
          <Pending timeframe={profile.timeframe} />
        </>
      );
    }
    const screen = render(
      <Suspense fallback={<span>pending</span>}>
        <Owner target="public-target" />
      </Suspense>,
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(current.cache.isFetching()).toBe(0));
    const original = profile;
    act(() => {
      startTransition(() => original.setTimeframe('lastWeek'));
    });
    await waitFor(() => expect(attempted).toBe(true));
    expect(screen.getByTestId('committed-filter').textContent).toBe('all');
    selected.focused = false;
    screen.rerender(
      <Suspense fallback={<span>pending</span>}>
        <Owner target="other-target" />
      </Suspense>,
    );
    screen.rerender(
      <Suspense fallback={<span>pending</span>}>
        <Owner target="public-target" />
      </Suspense>,
    );
    blocked = false;
    await act(async () => {
      resume();
      await gate;
    });
    // Check the retired lower-lane action before any newer valid selection
    // could overwrite and mask an invalid replay.
    expect(screen.getByTestId('committed-filter').textContent).toBe('all');
    act(() => profile.setTimeframe('lastMonth'));
    expect(screen.getByTestId('committed-filter').textContent).toBe('lastMonth');
    expect(current.issueLease).toHaveBeenCalledOnce();
  });

  it('keeps a real StrictMode replacement live while retained unmounted retry/refresh owners remain inert', async () => {
    const current = fixture();
    const first = render(
      <StrictMode>
        <Progress target="public-target" />
      </StrictMode>,
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(first.getByTestId('actual-refresh-control')).toBeTruthy());
    await waitFor(() => expect(current.cache.isFetching()).toBe(0));
    const retired = selected.refresh!;
    first.unmount();
    const replacement = render(
      <StrictMode>
        <Progress target="public-target" />
      </StrictMode>,
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(replacement.getByTestId('actual-refresh-control')).toBeTruthy());
    const before = current.performFetch.mock.calls.length;
    act(() => retired());
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.performFetch).toHaveBeenCalledTimes(before);
    fireEvent.click(replacement.getByTestId('actual-refresh-control'));
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(before + BOARD_TYPES.length + 2));
    await waitFor(() => expect(current.cache.isFetching()).toBe(0));
    expect(replacement.queryByTestId('profile-board-overview-error')).toBeNull();
  });
  it.each([false, true])(
    'retains exact fixed retry intent while actual TanStack fetch is paused (retire=%s)',
    async (retire) => {
      const current = fixture();
      const screen = render(<Progress target="public-target" />, { wrapper: current.wrapper });
      await waitFor(() => expect(screen.getByTestId('actual-refresh-control')).toBeTruthy());
      const refresh = selected.refresh!;
      const before = current.performFetch.mock.calls.length;
      onlineManager.setOnline(false);
      act(() => refresh());
      await waitFor(() =>
        expect(
          current.cache
            .getQueryCache()
            .findAll()
            .filter((query) => query.state.fetchStatus === 'paused'),
        ).toHaveLength(3),
      );
      expect(current.performFetch).toHaveBeenCalledTimes(before);
      if (retire) {
        selected.focused = false;
        screen.rerender(<Progress target="other-target" />);
        screen.rerender(<Progress target="public-target" />);
      }
      onlineManager.setOnline(true);
      await waitFor(() =>
        expect(
          current.cache
            .getQueryCache()
            .findAll()
            .every((query) => query.state.fetchStatus === 'idle'),
        ).toBe(true),
      );
      expect(current.performFetch).toHaveBeenCalledTimes(before + (retire ? 0 : BOARD_TYPES.length + 2));
    },
  );
});
