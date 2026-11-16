// @vitest-environment jsdom
import {
  createElement,
  useState,
  useSyncExternalStore,
  Suspense,
  StrictMode,
  startTransition,
  type ReactNode,
} from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../../http-query-scope';
import type { createScopedHttpFixture } from '../../__tests__/fixtures/scoped-http';
import type { Proposal } from '@boardsesh/shared-schema';
const ports = vi.hoisted(() => ({
  http: null as ReturnType<typeof createScopedHttpFixture> | null,
  scope: null as HttpQueryScope | null,
  push: vi.fn(),
  haptic: vi.fn(),
  moderation: true,
  themeRevision: 0,
  themeNextInstance: 0,
  themeInstances: new Map<number, () => void>(),
  themeListeners: new Set<() => void>(),
  presses: [] as Array<() => void>,
}));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    throw new Error('Unexpected native transport');
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline transport');
  },
}));
vi.mock('../../use-http-query-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../use-http-query-scope')>();
  return { ...actual, useHttpQueryScope: () => ports.scope ?? actual.useHttpQueryScope() };
});
// Exact platform forwarding to the real full operation, not approving guards.
vi.mock('../../http-operation', () => ({
  createHttpOperation: (scope: string | undefined, options?: import('../../http-operation').HttpOperationOptions) => {
    if (!ports.http) throw new Error('Missing owned actual operation factory');
    return ports.http.operations.create(scope, options);
  },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: ports.push }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, variables?: Record<string, unknown>) => (variables ? `${key}:${JSON.stringify(variables)}` : key),
  }),
}));
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  useWindowDimensions: () => ({ width: 405, height: 900 }),
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: ({ light }: { light: string }) => light,
}));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => {
    ports.presses.push(onPress);
    return createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children);
  },
}));
const theme = { systemColors: { secondaryLabel: '#111', accent: '#222', separator: '#333' } };
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => {
    // Subscriber-local snapshots let the scheduling fixture render only an
    // actual descendant. A shared snapshot would make React's consistency
    // check render its parent too, hiding a missing descendant guard.
    const [snapshot] = useState(() => ({ revision: 0, instance: ports.themeNextInstance++ }));
    useSyncExternalStore(
      (listener) => {
        const notify = () => {
          snapshot.revision = ports.themeRevision;
          listener();
        };
        ports.themeListeners.add(notify);
        ports.themeInstances.set(snapshot.instance, notify);
        return () => {
          ports.themeListeners.delete(notify);
          ports.themeInstances.delete(snapshot.instance);
        };
      },
      () => snapshot.revision,
    );
    return theme;
  },
}));
vi.mock('../../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => ports.moderation }));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../haptics', () => ({ hapticSelection: ports.haptic }));
const { createScopedHttpFixture: makeHttp } = await import('../../__tests__/fixtures/scoped-http');
import { useClimbProposals } from '../use-climb-proposals';
import { useClimbLostHolds, CLIMB_LOST_HOLDS_QUERY_KEY } from '../use-climb-lost-holds';
import { climbProposalsKey, useClimbProposalsPinned } from '../use-browse-proposals';
import { useVoteOnProposal } from '../use-vote-on-proposal';
import { __resetConnectivityStoreForTests } from '../../../connectivity/connectivity-store';
const releases: Array<() => void> = [];
afterEach(() => {
  cleanup();
  releases
    .splice(0)
    .reverse()
    .forEach((release) => release());
  ports.http = null;
  ports.scope = null;
  ports.moderation = true;
  ports.themeRevision = 0;
  ports.themeNextInstance = 0;
  ports.themeInstances.clear();
  ports.themeListeners.clear();
  ports.presses.splice(0);
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
function fixture(anonymous = false) {
  __resetConnectivityStoreForTests();
  const http = makeHttp();
  if (anonymous) http.confirmAnonymous();
  ports.http = http;
  const scope = http.scope();
  ports.scope = scope;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  releases.push(() => {
    cache.clear();
    http.dispose();
  });
  const wrapper = ({ children }: { children?: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  return { ...http, scope, cache, wrapper };
}
function deferred<Value>() {
  let resolve!: (result: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function row(boardType = 'kilter', overrides: Partial<Proposal> = {}): Proposal {
  return {
    uuid: `proposal-${boardType}`,
    climbUuid: 'same-climb',
    boardType,
    angle: 40,
    proposerId: 'owned-A',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    reason: `PRIVATE-${boardType}`,
    createdAt: '2026-01-01',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 0,
    ...overrides,
  };
}
function envelope(proposal = row()) {
  return { climbProposals: { proposals: [proposal], totalCount: 1, hasMore: false } };
}
function packets(current: ReturnType<typeof fixture>) {
  return current.performFetch.mock.calls.map(
    ([, init]) =>
      JSON.parse((init as RequestInit).body as string) as {
        query: string;
        variables?: { input?: { boardType?: string; climbUuid?: string }; angle?: number };
      },
  );
}
const lostVariables = (climbUuid = 'parent-A') => ({
  boardName: 'spray',
  layoutId: 7,
  sizeId: 1,
  setIds: '1',
  angle: 40,
  climbUuid,
});
const lostRows = [
  { id: 2, cx: 100, cy: 100, r: 10, outline: null },
  { id: 4, cx: 200, cy: 200, r: 12, outline: null },
];
it('reads actual proposal raw envelopes with a selected canonical board key', async () => {
  const current = fixture();
  current.performFetch.mockImplementation(async () => Response.json({ data: envelope() }));
  const hook = renderHook(() => useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' }), {
    wrapper: current.wrapper,
  });
  await waitFor(() => expect(hook.result.current.data).toEqual([row()]));
  expect(current.cache.getQueryData(current.scope.key(climbProposalsKey('same-climb', 'kilter')))).toEqual(envelope());
  expect(current.cache.getQueryData(climbProposalsKey('same-climb'))).toBeUndefined();
  expect(packets(current)[0].variables).toEqual({ input: { climbUuid: 'same-climb', boardType: 'kilter', limit: 20 } });
});
it('refuses retained confirmed-anonymous lost-hold A rows after an SDK null answer and a pending B descriptor', async () => {
  const current = fixture(true);
  current.performFetch.mockImplementation(async () =>
    Response.json({ data: { climb: { uuid: 'parent-A', lostHolds: lostRows } } }),
  );
  const hook = renderHook(({ variables }) => useClimbLostHolds(variables), {
    initialProps: { variables: lostVariables() },
    wrapper: current.wrapper,
  });
  await waitFor(() => expect(hook.result.current).toEqual({ status: 'ready', lostHolds: lostRows }));
  const keyA = current.scope.key([...CLIMB_LOST_HOLDS_QUERY_KEY, lostVariables()]);
  current.performFetch.mockImplementationOnce(async () => Response.json({ data: null }));
  await act(async () => {
    await current.cache.refetchQueries({ queryKey: keyA, exact: true });
  });
  const nullState = current.cache.getQueryState(keyA);
  // Selector errors live on QueryObserver, not Query.state.error. The raw
  // actual SDK answer is null while the leaf still exposes its prior A rows.
  expect(nullState?.data).toBeNull();
  expect(hook.result.current).toEqual({ status: 'ready', lostHolds: lostRows });
  const held = deferred<Response>();
  current.performFetch.mockReturnValueOnce(held.promise);
  hook.rerender({ variables: lostVariables('parent-B') });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
  expect(hook.result.current).toEqual({ status: 'loading' });
  held.resolve(Response.json({ data: { climb: { uuid: 'parent-B', lostHolds: [] } } }));
  await waitFor(() => expect(hook.result.current).toEqual({ status: 'ready', lostHolds: [] }));
});

function heldEnvelope(answer: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function answerPackets(current: ReturnType<typeof fixture>) {
  return packets(current).filter((packet) => !packet.query.includes('viewer'));
}
it.each(['empty-climb', 'empty-board', 'disabled', 'kill'] as const)(
  'preserves proposal %s gates without a packet',
  async (gate) => {
    const current = fixture();
    ports.moderation = gate !== 'kill';
    renderHook(
      () =>
        useClimbProposals({
          climbUuid: gate === 'empty-climb' ? '' : 'same-climb',
          boardType: gate === 'empty-board' ? '' : 'kilter',
          enabled: gate !== 'disabled' && ports.moderation,
        }),
      { wrapper: current.wrapper },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.performFetch).not.toHaveBeenCalled();
  },
);
it('keeps null lost-hold input idle and does no lease or GraphQL work', async () => {
  const current = fixture();
  const hook = renderHook(() => useClimbLostHolds(null), { wrapper: current.wrapper });
  expect(hook.result.current).toEqual({ status: 'idle' });
  expect(current.issueLease).not.toHaveBeenCalled();
  expect(current.performFetch).not.toHaveBeenCalled();
});
it('preserves complete copied selected lost-hold request variables while the actual lease is held', async () => {
  const current = fixture();
  const admitted = deferred<Response>();
  current.issueLease.mockReturnValueOnce(admitted.promise);
  current.performFetch.mockImplementation(async () => Response.json({ data: { climb: { lostHolds: [] } } }));
  const variables = lostVariables();
  const hook = renderHook(() => useClimbLostHolds(variables), { wrapper: current.wrapper });
  await waitFor(() => expect(current.issueLease).toHaveBeenCalledTimes(1));
  variables.angle = 60;
  variables.climbUuid = 'edited-after-capture';
  admitted.resolve(
    Response.json({
      status: 'admitted',
      token: 'bsbd1_OWNED_TEST_ONLY',
      usableForMs: 120_000,
      owner: {
        userId: 'owned-A',
        authSessionId: 'owned-SID-A',
        generation: 1,
        cursor: { bindingId: 'a'.repeat(64), version: 2 },
      },
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  expect(packets(current)[0].variables).toEqual(lostVariables());
});
it('rejects unavailable selected authority without issuing anonymous GraphQL fallback', async () => {
  const current = fixture();
  current.issueLease.mockResolvedValue(Response.json({ status: 'unavailable' }, { status: 503 }));
  const hook = renderHook(() => useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' }), {
    wrapper: current.wrapper,
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(current.performFetch).not.toHaveBeenCalled();
  expect(hook.result.current.data).toBeUndefined();
});
it.each(['B', 'ABA', 'expired'] as const)(
  'refuses original proposal body after %s despite a fresh current lease',
  async (retirement) => {
    const current = fixture();
    const original = current.scope;
    const body = heldEnvelope({ data: envelope() });
    current.performFetch.mockResolvedValueOnce(body.response);
    const hook = renderHook(() => useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' }), {
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    if (retirement === 'expired') {
      current.clock(90_000);
      await original.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    } else {
      current.switchAccount('owned-B');
      if (retirement === 'ABA') current.switchAccount('owned-A');
      await ports.http!.scope().run((operation) => operation.request('{ viewer { id } }'));
    }
    await act(async () => {
      body.release();
    });
    await waitFor(() =>
      expect(current.cache.getQueryState(original.key(climbProposalsKey('same-climb', 'kilter')))?.fetchStatus).toBe(
        'idle',
      ),
    );
    expect(current.cache.getQueryData(original.key(climbProposalsKey('same-climb', 'kilter')))).toBeUndefined();
    expect(hook.result.current.data).toBeUndefined();
    expect(answerPackets(current)).toHaveLength(1);
  },
);
it('preserves current authentic GraphQL error identity and refuses partial data cache publication', async () => {
  const current = fixture();
  current.performFetch.mockResolvedValue(
    Response.json({ data: envelope(), errors: [{ message: 'owned exact failure' }] }),
  );
  const hook = renderHook(() => useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' }), {
    wrapper: current.wrapper,
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.error).toHaveProperty('response.errors', [{ message: 'owned exact failure' }]);
  expect(current.cache.getQueryData(current.scope.key(climbProposalsKey('same-climb', 'kilter')))).toBeUndefined();
  expect(current.performFetch).toHaveBeenCalledTimes(1);
});
it('refuses authenticated SDK null and keeps actual admitted rows without publishing null', async () => {
  const current = fixture();
  current.performFetch.mockImplementation(async () => Response.json({ data: { climb: { lostHolds: lostRows } } }));
  const hook = renderHook(() => useClimbLostHolds(lostVariables()), { wrapper: current.wrapper });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  current.performFetch.mockImplementation(async () => Response.json({ data: null }));
  await act(async () => {
    await current.cache.refetchQueries({
      queryKey: current.scope.key([...CLIMB_LOST_HOLDS_QUERY_KEY, lostVariables()]),
      exact: true,
    });
  });
  expect(current.cache.getQueryData(current.scope.key([...CLIMB_LOST_HOLDS_QUERY_KEY, lostVariables()]))).toEqual({
    climb: { lostHolds: lostRows },
  });
  expect(hook.result.current).toEqual({ status: 'ready', lostHolds: lostRows });
});
it('separates same-climb board A/B/A while sharing one raw cache with pinned and actual scoped voting', async () => {
  const current = fixture();
  const body = deferred<Response>();
  current.performFetch.mockImplementation(async (_url, init) => {
    const packet = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: { input: { boardType: string } };
    };
    return Response.json({ data: envelope(row(packet.variables.input.boardType)) });
  });
  const hook = renderHook(
    ({ boardType }) => ({
      leaf: useClimbProposals({ climbUuid: 'same-climb', boardType }),
      pinned: useClimbProposalsPinned({ climbUuid: 'same-climb', boardType, enabled: true }),
      vote: useVoteOnProposal(),
    }),
    { initialProps: { boardType: 'kilter' }, wrapper: current.wrapper },
  );
  await waitFor(() => expect(hook.result.current.leaf.data).toEqual([row()]));
  expect(current.performFetch).toHaveBeenCalledTimes(1);
  expect(hook.result.current.pinned.data).toEqual(envelope());
  hook.rerender({ boardType: 'tension' });
  await waitFor(() => expect(hook.result.current.leaf.data).toEqual([row('tension')]));
  expect(current.performFetch).toHaveBeenCalledTimes(2);
  hook.rerender({ boardType: 'kilter' });
  await waitFor(() => expect(hook.result.current.leaf.data).toEqual([row()]));
  expect(current.performFetch).toHaveBeenCalledTimes(2);
  current.cache.setQueryData(climbProposalsKey('same-climb'), envelope());
  const rawBefore = current.cache.getQueryData(climbProposalsKey('same-climb'));
  current.performFetch.mockReturnValueOnce(body.promise);
  let pending!: Promise<unknown>;
  act(() => {
    pending = hook.result.current.vote.mutateAsync({ proposalUuid: 'proposal-kilter', value: 1 });
  });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(hook.result.current.leaf.data?.[0].userVote).toBe(1));
  expect(hook.result.current.pinned.data?.climbProposals.proposals[0].userVote).toBe(1);
  const final = row('kilter', { userVote: 1, weightedUpvotes: 9 });
  await act(async () => {
    body.resolve(Response.json({ data: { voteOnProposal: final } }));
    await pending;
  });
  await waitFor(() => expect(hook.result.current.leaf.data).toEqual([final]));
  expect(hook.result.current.pinned.data).toEqual(envelope(final));
  expect(current.cache.getQueryData(current.scope.key(climbProposalsKey('same-climb', 'tension')))).toEqual(
    envelope(row('tension')),
  );
  expect(current.cache.getQueryData(climbProposalsKey('same-climb'))).toEqual(rawBefore);
});
it('keeps a real pinned observer and its pending request live after leaf deletion and later refetch', async () => {
  const current = fixture();
  const body = heldEnvelope({ data: envelope() });
  current.performFetch.mockResolvedValueOnce(body.response);
  function Leaf() {
    useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' });
    return null;
  }
  let pinned: ReturnType<typeof useClimbProposalsPinned>;
  function Host({ leaf }: { leaf: boolean }) {
    pinned = useClimbProposalsPinned({ climbUuid: 'same-climb', boardType: 'kilter', enabled: true });
    return leaf ? <Leaf /> : null;
  }
  const view = render(<Host leaf />, { wrapper: current.wrapper });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
  view.rerender(<Host leaf={false} />);
  const signal = current.performFetch.mock.calls[0][1] as RequestInit;
  expect(signal.signal?.aborted).toBe(false);
  await act(async () => {
    body.release();
  });
  await waitFor(() => expect(pinned!.data).toEqual(envelope()));
  current.performFetch.mockImplementation(async () =>
    Response.json({ data: envelope(row('kilter', { reason: 'current-refetch' })) }),
  );
  await act(async () => {
    await current.cache.refetchQueries({
      queryKey: current.scope.key(climbProposalsKey('same-climb', 'kilter')),
      exact: true,
    });
  });
  await waitFor(() => expect(pinned!.data).toEqual(envelope(row('kilter', { reason: 'current-refetch' }))));
  expect(current.performFetch).toHaveBeenCalledTimes(2);
});

import { ClimbModerationStatus } from '../../../../components/play-drawer/ClimbModerationStatus';
import { useLostHoldGhosts } from '../../../../components/create-climb/use-lost-hold-ghosts';
import { registerSprayWall, unregisterSprayWall } from '../../../spray/spray-wall-registry';
const moderationProps = { climbUuid: 'same-climb', boardName: 'kilter', angle: 40, isHidden: false };
function serveModeration(current: ReturnType<typeof fixture>, proposal = row('kilter', { status: 'approved' })) {
  current.performFetch.mockImplementation(async (_url, init) => {
    const packet = JSON.parse((init as RequestInit).body as string) as { query: string };
    return Response.json({
      data: packet.query.includes('GetComments')
        ? {
            comments: {
              comments: [
                {
                  uuid: 'reason-other',
                  userId: 'other',
                  userDisplayName: 'PRIVATE-AUTHOR',
                  body: 'PRIVATE-THREAD',
                  createdAt: '2026-01-01',
                  isDeleted: false,
                },
              ],
              hasMore: false,
              totalCount: 1,
            },
          }
        : envelope(proposal),
    });
  });
}
function tickTheme() {
  ports.themeRevision += 1;
  for (const listener of ports.themeListeners) listener();
}
it('renders actual selected moderation reasons and routes current links through real action scope', async () => {
  const current = fixture();
  serveModeration(current);
  const view = render(<ClimbModerationStatus {...moderationProps} />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-kilter'));
  await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-THREAD'));
  fireEvent.click(view.getByRole('button'));
  expect(ports.push).toHaveBeenCalledWith({
    pathname: '/moderation',
    params: { proposalUuid: 'proposal-kilter', climbUuid: 'same-climb', boardType: 'kilter' },
  });
});
it.each(['boardABA', 'entityABA', 'viewABA', 'unmount'] as const)(
  'refuses retained actual moderation callbacks after %s while current controls remain live',
  async (retirement) => {
    const current = fixture();
    serveModeration(current);
    const view = render(<ClimbModerationStatus {...moderationProps} />, { wrapper: current.wrapper });
    await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-kilter'));
    const old = ports.presses.at(-1)!;
    if (retirement === 'unmount') view.unmount();
    else if (retirement === 'viewABA') {
      current.switchAccount('owned-B');
      current.switchAccount('owned-A');
      ports.scope = ports.http!.scope();
      view.rerender(<ClimbModerationStatus key="new-auth-owner" {...moderationProps} />);
    } else {
      const changed =
        retirement === 'boardABA'
          ? { ...moderationProps, boardName: 'tension' }
          : { ...moderationProps, climbUuid: 'other-climb' };
      view.rerender(<ClimbModerationStatus {...changed} />);
      view.rerender(<ClimbModerationStatus {...moderationProps} />);
    }
    act(() => old());
    expect(ports.push).not.toHaveBeenCalled();
    if (retirement !== 'unmount') {
      await waitFor(() => expect(view.queryAllByRole('button').length).toBe(1));
      fireEvent.click(view.getByRole('button'));
      expect(ports.push).toHaveBeenCalledTimes(1);
    }
  },
);
it('masks retired independently-rendering moderation descendants before comments, private text, or navigation', async () => {
  const current = fixture();
  serveModeration(current);
  const view = render(<ClimbModerationStatus {...moderationProps} />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-THREAD'));
  const old = ports.presses.at(-1)!;
  const count = current.performFetch.mock.calls.length;
  current.switchAccount('owned-B');
  ports.scope = ports.http!.scope();
  act(() => tickTheme());
  expect(view.container.textContent).not.toContain('PRIVATE');
  expect(view.queryAllByRole('button')).toHaveLength(0);
  act(() => old());
  expect(ports.push).not.toHaveBeenCalled();
  expect(current.performFetch).toHaveBeenCalledTimes(count);
});
it('isolates actual moderation selector errors from pending same-climb board B and preserves current B result', async () => {
  const current = fixture(true);
  serveModeration(current);
  const view = render(<ClimbModerationStatus {...moderationProps} />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-kilter'));
  current.performFetch.mockImplementationOnce(async () => Response.json({ data: null }));
  await act(async () => {
    await current.cache.refetchQueries({
      queryKey: current.scope.key(climbProposalsKey('same-climb', 'kilter')),
      exact: true,
    });
  });
  const held = deferred<Response>();
  current.performFetch.mockReturnValueOnce(held.promise);
  view.rerender(<ClimbModerationStatus {...moderationProps} boardName="tension" />);
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(4));
  expect(view.container.textContent).not.toContain('PRIVATE-kilter');
  expect(view.queryAllByRole('button')).toHaveLength(0);
  held.resolve(Response.json({ data: envelope(row('tension')) }));
  await waitFor(() => expect(view.queryAllByRole('button')).toHaveLength(1));
  fireEvent.click(view.getByRole('button'));
  expect(ports.push).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ boardType: 'tension' }) }),
  );
});
it('keeps actual moderation uninvoked controls live through StrictMode re-setup', async () => {
  const current = fixture();
  serveModeration(current);
  const view = render(
    <StrictMode>
      <ClimbModerationStatus {...moderationProps} />
    </StrictMode>,
    { wrapper: current.wrapper },
  );
  await waitFor(() => expect(view.queryAllByRole('button')).toHaveLength(1));
  fireEvent.click(view.getByRole('button'));
  expect(ports.push).toHaveBeenCalledTimes(1);
});
const board = { boardName: 'spray' as const, layoutId: 7, sizeId: 1, setIds: '1', angle: 40 };
const liveIds = new Set([1, 3]);
function ghostArgs(parentClimbUuid = 'parent-A') {
  return {
    board,
    parentClimbUuid,
    sourceFrames: 'p1r1p2r2p3r3p4r2',
    availableHoldIds: liveIds,
    sprayWallToken: 'owned-original-wall',
  };
}
function registerOwnedWall() {
  registerSprayWall(7, {
    wallUuid: 'owned-test-wall',
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 1000,
    photoHeight: 1000,
    photoUrl: 'https://owned.test/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01',
    holds: [
      { id: 1, cx: 0, cy: 0, r: 10 },
      { id: 3, cx: 300, cy: 300, r: 10 },
    ],
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  });
  releases.push(() => unregisterSprayWall(7));
}
function serveGhosts(current: ReturnType<typeof fixture>) {
  registerOwnedWall();
  current.performFetch.mockImplementation(async () => Response.json({ data: { climb: { lostHolds: lostRows } } }));
}
it('uses actual SDK and real registered wall geometry for current ghost haptics and two exact ring dismissals', async () => {
  const current = fixture();
  serveGhosts(current);
  const hook = renderHook(() => useLostHoldGhosts(ghostArgs()), { wrapper: current.wrapper });
  await waitFor(() => expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([2, 4]));
  expect(hook.result.current.ghostTargets).toEqual(lostRows.map(({ outline: _outline, ...target }) => target));
  act(() => hook.result.current.dismissGhost(2));
  expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([4]);
  act(() => hook.result.current.dismissGhost(4));
  expect(hook.result.current.ghosts).toEqual([]);
  expect(ports.haptic).toHaveBeenCalledTimes(2);
  expect(current.performFetch).toHaveBeenCalledTimes(1);
});
it.each(['targetABA', 'boardABA', 'viewABA', 'unmount'] as const)(
  'refuses original local ghost control after %s without deleting newer rings',
  async (retirement) => {
    const current = fixture();
    serveGhosts(current);
    const hook = renderHook(({ args }) => useLostHoldGhosts(args), {
      initialProps: { args: ghostArgs() },
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
    const old = hook.result.current.dismissGhost;
    if (retirement === 'unmount') hook.unmount();
    else if (retirement === 'viewABA') {
      current.switchAccount('owned-B');
      current.switchAccount('owned-A');
      ports.scope = ports.http!.scope();
      hook.rerender({ args: ghostArgs() });
    } else {
      const changed = ghostArgs('parent-B');
      if (retirement === 'boardABA') changed.board = { ...board, angle: 50 };
      hook.rerender({ args: changed });
      await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
      hook.rerender({ args: ghostArgs() });
      await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
    }
    act(() => old(2));
    expect(ports.haptic).not.toHaveBeenCalled();
    if (retirement === 'targetABA' || retirement === 'boardABA') {
      expect(hook.result.current.ghosts).toHaveLength(2);
      act(() => hook.result.current.dismissGhost(2));
      expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([4]);
    }
  },
);
it('refuses a started ghost action after reentrant target commit from the real haptic', async () => {
  const current = fixture();
  serveGhosts(current);
  const hook = renderHook(({ args }) => useLostHoldGhosts(args), {
    initialProps: { args: ghostArgs() },
    wrapper: current.wrapper,
  });
  await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
  const old = hook.result.current.dismissGhost;
  ports.haptic.mockImplementationOnce(() => {
    hook.rerender({ args: ghostArgs('parent-B') });
  });
  act(() => old(2));
  await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
  expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([2, 4]);
});
it('keeps already-admitted local ghost input usable after its original lease expires', async () => {
  const current = fixture();
  serveGhosts(current);
  const hook = renderHook(() => useLostHoldGhosts(ghostArgs()), { wrapper: current.wrapper });
  await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
  current.clock(90_000);
  await current.scope.run((operation) => operation.request('{ viewer { id } }'));
  current.clock(120_001);
  act(() => hook.result.current.dismissGhost(2));
  expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([4]);
  expect(ports.haptic).toHaveBeenCalledTimes(1);
  expect(current.performFetch).toHaveBeenCalledTimes(2);
});
it('keeps new uninvoked ghost controls live after real StrictMode cleanup and re-setup', async () => {
  const current = fixture();
  serveGhosts(current);
  function Wrapper({ children }: { children?: ReactNode }) {
    return (
      <current.wrapper>
        <StrictMode>{children}</StrictMode>
      </current.wrapper>
    );
  }
  const hook = renderHook(() => useLostHoldGhosts(ghostArgs()), { wrapper: Wrapper });
  await waitFor(() => expect(hook.result.current.ghosts).toHaveLength(2));
  act(() => hook.result.current.dismissGhost(2));
  expect(hook.result.current.ghosts.map((ghost) => ghost.id)).toEqual([4]);
});
it.each(['current', 'target-retired'] as const)(
  'replays a genuinely suspended local ghost updater with %s committed owner',
  async (outcome) => {
    const current = fixture();
    serveGhosts(current);
    const paused = deferred<void>();
    let released = false;
    const attempted: number[][] = [];
    let controls!: {
      dismiss: (id: number) => void;
      setBlock: (block: boolean) => void;
      setTarget: (target: string) => void;
      urgent: () => void;
    };
    function Pending({ block, ids }: { block: boolean; ids: number[] }) {
      if (block && !released && ids.length === 1) {
        attempted.push(ids);
        throw paused.promise;
      }
      return null;
    }
    function Host() {
      const [target, setTarget] = useState('parent-A');
      const [block, setBlock] = useState(false);
      const [, setTick] = useState(0);
      const lost = useLostHoldGhosts(ghostArgs(target));
      controls = { dismiss: lost.dismissGhost, setBlock, setTarget, urgent: () => setTick((count) => count + 1) };
      const ids = lost.ghosts.map((ghost) => ghost.id);
      return (
        <>
          <span data-testid="committed-ghosts">{ids.join(',')}</span>
          <Pending block={block} ids={ids} />
        </>
      );
    }
    const view = render(
      <Suspense fallback={<span>fallback</span>}>
        <Host />
      </Suspense>,
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(view.getByTestId('committed-ghosts').textContent).toBe('2,4'));
    act(() =>
      startTransition(() => {
        controls.dismiss(2);
        controls.setBlock(true);
      }),
    );
    await waitFor(() => expect(attempted).toContainEqual([4]));
    expect(view.getByTestId('committed-ghosts').textContent).toBe('2,4');
    expect(view.queryByText('fallback')).toBeNull();
    if (outcome === 'target-retired') {
      act(() => controls.setTarget('parent-B'));
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(view.getByTestId('committed-ghosts').textContent).toBe('2,4'));
      act(() => controls.setTarget('parent-A'));
    } else act(() => controls.urgent());
    await act(async () => {
      released = true;
      paused.resolve();
      await paused.promise;
    });
    await waitFor(() =>
      expect(view.getByTestId('committed-ghosts').textContent).toBe(outcome === 'current' ? '4' : '2,4'),
    );
    expect(ports.haptic).toHaveBeenCalledTimes(1);
  },
);
it('keeps uninvoked ghost control live after actual Suspense disconnect but refuses its started cleanup continuation', async () => {
  const current = fixture();
  serveGhosts(current);
  const paused = deferred<void>();
  let blocked = false;
  let latest!: ReturnType<typeof useLostHoldGhosts>;
  function Host() {
    latest = useLostHoldGhosts(ghostArgs());
    if (blocked) throw paused.promise;
    return <span data-testid="rings">{latest.ghosts.map((ghost) => ghost.id).join(',')}</span>;
  }
  const view = render(
    <Suspense fallback={<span>hidden-editor</span>}>
      <Host />
    </Suspense>,
    { wrapper: current.wrapper },
  );
  await waitFor(() => expect(view.getByTestId('rings').textContent).toBe('2,4'));
  const uninvoked = latest.dismissGhost;
  act(() => {
    blocked = true;
    view.rerender(
      <Suspense fallback={<span>hidden-editor</span>}>
        <Host />
      </Suspense>,
    );
  });
  expect(view.getByText('hidden-editor')).toBeTruthy();
  await act(async () => {
    blocked = false;
    paused.resolve();
    await paused.promise;
  });
  await waitFor(() => expect(view.getByTestId('rings').textContent).toBe('2,4'));
  act(() => uninvoked(2));
  expect(view.getByTestId('rings').textContent).toBe('4');
  ports.haptic.mockImplementationOnce(() => {
    blocked = true;
    view.rerender(
      <Suspense fallback={<span>hidden-editor</span>}>
        <Host />
      </Suspense>,
    );
  });
  act(() => latest.dismissGhost(4));
  expect(view.getByText('hidden-editor')).toBeTruthy();
  await act(async () => {
    blocked = false;
    view.rerender(
      <Suspense fallback={<span>hidden-editor</span>}>
        <Host />
      </Suspense>,
    );
  });
  await waitFor(() => expect(view.getByTestId('rings').textContent).toBe('4'));
  act(() => latest.dismissGhost(4));
  expect(view.getByTestId('rings').textContent).toBe('');
});

// Render/layout leaves only: the actual drawer owns the Save predicate and
// consumes the actual SDK-backed ghost hook. No editor writer or BLE claim.
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../../hooks/use-keyboard-height', () => ({ useKeyboardHeight: () => 0 }));
vi.mock('../../../spray/use-spray-wall-leds-enabled', () => ({ useSprayWallLedsEnabled: () => false }));
vi.mock('../../../../components/create-climb/AccessibleHoldList', () => ({ AccessibleHoldList: () => null }));
vi.mock('../../../../components/create-climb/InteractiveCreateBoard', () => ({ InteractiveCreateBoard: () => null }));
vi.mock('../../../../components/create-climb/CreateDrawerHeader', () => ({
  CreateDrawerHeader: ({ climbReady, onSave }: { climbReady: boolean; onSave: () => void }) => (
    <button disabled={!climbReady} onClick={onSave}>
      Actual drawer Save gate
    </button>
  ),
}));
vi.mock('../../../../components/create-climb/CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: ({ saveBlockedLine }: { saveBlockedLine?: ReactNode }) => <div>{saveBlockedLine}</div>,
}));
vi.mock('../../../../components/create-climb/CreateDrawerForm', () => ({ CreateDrawerForm: () => null }));
vi.mock('../../../../components/create-climb/CreateRoutePlaybackSlot', () => ({ CreateRoutePlaybackSlot: () => null }));
vi.mock('../../../../components/create-climb/OpenDraftsSection', () => ({ OpenDraftsSection: () => null }));
vi.mock('../../../../components/create-climb/InlineConfirmBanner', () => ({ InlineConfirmBanner: () => null }));
vi.mock('../../../../components/create-climb/DuplicateBanner', () => ({ DuplicateBanner: () => null }));
vi.mock('../../../../components/create-climb/LostHoldGhostLayer', () => ({ LostHoldGhostLayer: () => null }));
vi.mock('../../../../components/board/HeatmapOverlay', () => ({
  HeatmapOverlay: () => null,
  useHeatLayer: () => ({ cells: [], codeColors: {}, legend: { kind: 'count', edgeValues: [], total: 0 } }),
}));
vi.mock('../../../../components/board/HeatmapLegend', () => ({
  HeatmapLegend: () => null,
  formatHeatmapClimbCount: () => '',
}));
vi.mock('../../../../components/board/HeatmapDownloadLine', () => ({ HeatmapDownloadLine: () => null }));
import { CreateDrawer } from '../../../../components/create-climb/CreateDrawer';
it('feeds actual SDK ghosts through CreateDrawer and enables its Save predicate only after the last real dismissal', async () => {
  const current = fixture();
  serveGhosts(current);
  const save = vi.fn();
  let lost!: ReturnType<typeof useLostHoldGhosts>;
  type Controller = Parameters<typeof CreateDrawer>[0]['controller'];
  const controller = {
    name: 'Owned remix',
    setName: vi.fn(),
    focusNameSignal: 0,
    litUpHoldsMap: {},
    frameCount: 1,
    currentFrameIndex: 0,
    blankClimbEpoch: 0,
    supportsMultiFrame: true,
    routeMode: false,
    showRouteTransport: false,
    playback: {},
    saveState: 'ready',
    handleSave: save,
    publishBlocked: false,
    canSave: true,
    canPublish: true,
    draftStatus: null,
    pendingNewClimb: false,
    publishDuplicateError: null,
    isDraft: false,
  } as unknown as Controller;
  function Host() {
    lost = useLostHoldGhosts(ghostArgs());
    return (
      <CreateDrawer
        board={board}
        controller={controller}
        boardHolds={{ holdTargets: [], boardWidth: 650, boardHeight: 1000 }}
        onLongPressHold={() => {}}
        onLoadDraft={() => {}}
        onClose={() => {}}
        onViewDuplicate={() => {}}
        lostHolds={lost}
      />
    );
  }
  const view = render(<Host />, { wrapper: current.wrapper });
  await waitFor(() => expect(lost.ghosts).toHaveLength(2));
  const button = view.getByRole('button', { name: 'Actual drawer Save gate' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(save).not.toHaveBeenCalled();
  act(() => lost.dismissGhost(2));
  expect(button.disabled).toBe(true);
  act(() => lost.dismissGhost(4));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(save).toHaveBeenCalledTimes(1);
  expect(ports.haptic).toHaveBeenCalledTimes(2);
  expect(current.performFetch).toHaveBeenCalledTimes(1);
});
it.each(['session-id', 'session-version', 'auth-generation'] as const)(
  'refuses held original reads after real %s authority retirement',
  async (change) => {
    const current = fixture();
    const body = heldEnvelope({ data: envelope() });
    current.performFetch.mockResolvedValueOnce(body.response);
    const hook = renderHook(() => useClimbProposals({ climbUuid: 'same-climb', boardType: 'kilter' }), {
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    if (change === 'auth-generation') current.nextGeneration();
    else {
      const owner = {
        userId: 'owned-A',
        authSessionId: change === 'session-id' ? 'owned-new-SID' : 'owned-SID-A',
        generation: 1,
        cursor: { bindingId: 'a'.repeat(64), version: change === 'session-version' ? 3 : 2 },
      };
      current.backend.acceptSession({
        user: { id: 'owned-A' },
        authSessionId: owner.authSessionId,
        authGeneration: 1,
        expires: '2099-01-01T00:00:00.000Z',
        browserSelection: owner,
      });
      current.issueLease.mockImplementation(async () =>
        Response.json({ status: 'admitted', token: 'bsbd1_OWNED_TEST_ONLY', usableForMs: 120_000, owner }),
      );
      await current.backend.acquire(owner);
    }
    await act(async () => {
      body.release();
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.data).toBeUndefined();
    expect(current.cache.getQueryData(current.scope.key(climbProposalsKey('same-climb', 'kilter')))).toBeUndefined();
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  },
);
it.each(['unknown', 'copied-sdk'] as const)(
  'refuses %s transport failures as authenticated API guidance',
  async (kind) => {
    const current = fixture();
    current.performFetch.mockImplementation(async () =>
      Response.json({ errors: [{ message: 'actual original SDK error' }] }),
    );
    const hook = renderHook(({ climbUuid }) => useClimbProposals({ climbUuid, boardType: 'kilter' }), {
      initialProps: { climbUuid: 'same-climb' },
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    const original = hook.result.current.error;
    expect(original).toHaveProperty('response.errors', [{ message: 'actual original SDK error' }]);
    const failure =
      kind === 'unknown' ? new Error('not an SDK delivery') : Object.assign(new Error(original!.message), original);
    current.performFetch.mockRejectedValue(failure);
    hook.rerender({ climbUuid: 'other-climb' });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error).not.toBe(failure);
    expect(hook.result.current.error).toHaveProperty('status');
    expect(hook.result.current.data).toBeUndefined();
  },
);
it('guards reason and link descendants when only their actual theme subscriptions render', async () => {
  const current = fixture();
  serveModeration(current);
  const view = render(<ClimbModerationStatus {...moderationProps} />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('PRIVATE-THREAD'));
  // Birth0 is the actual parent; effect subscription order is child-first.
  // Invoke the other two owned instances, never infer ownership from Set order.
  expect(Array.from(ports.themeInstances.keys()).sort((left, right) => left - right)).toEqual([0, 1, 2]);
  const descendants = [ports.themeInstances.get(1)!, ports.themeInstances.get(2)!];
  current.switchAccount('owned-B');
  ports.scope = ports.http!.scope();
  await ports.scope.run((operation) => operation.request('{ viewer { id } }'));
  expect(view.container.textContent).toContain('PRIVATE-THREAD');
  act(() => {
    ports.themeRevision += 1;
    descendants.forEach((notify) => notify());
  });
  expect(view.container.textContent).toContain('PRIVATE-kilter'); // Parent was not scheduled.
  expect(view.container.textContent).not.toContain('PRIVATE-THREAD');
  expect(view.container.textContent).not.toContain('PRIVATE-AUTHOR');
  expect(view.queryAllByRole('button')).toHaveLength(0);
});
