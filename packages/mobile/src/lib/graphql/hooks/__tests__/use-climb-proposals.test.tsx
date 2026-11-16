// @vitest-environment jsdom
//
// The play drawer's read of a climb's proposals. Three things here are contracts
// rather than implementation detail:
//   - the cache key AND the cached document shape must match the moderation
//     feed's own per-climb query, or a vote cast in the feed either misses this
//     entry or overwrites it with a shape the drawer can't read;
//   - the query runs SIGNED OUT (a hidden climb reads as hidden to everyone), so
//     it must not be gated on an auth token;
//   - callers get the proposal array, not the connection wrapper.
//
// Imports the hook file directly rather than the `hooks` barrel — the barrel
// statically reaches react-native's Flow source, which Rolldown's scan refuses
// (same reason `use-notifications.test.tsx` does).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, onlineManager, type QueryFunctionContext } from '@tanstack/react-query';
import type { Proposal } from '@boardsesh/shared-schema';
import { GET_CLIMB_LOST_HOLDS } from '@boardsesh/graphql/operations';

const requestMock = vi.hoisted(() => vi.fn());
const actualSdkOptions = vi.hoisted(
  () =>
    [] as Array<{
      document: unknown;
      variables: unknown;
      requestHeaders: undefined;
      signal: AbortSignal;
    }>,
);

vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: (...parameters: unknown[]) => {
      const first = parameters[0];
      if (parameters.length === 1 && first !== null && typeof first === 'object') {
        const keys = Reflect.ownKeys(first);
        const allowed = ['document', 'variables', 'requestHeaders', 'signal'];
        if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key)))
          throw new Error('Unexpected native SDK option fields');
        if (
          !('document' in first) ||
          !('variables' in first) ||
          !('requestHeaders' in first) ||
          !('signal' in first) ||
          first.requestHeaders !== undefined ||
          !(first.signal instanceof AbortSignal)
        )
          throw new Error('Unsupported native SDK request options');
        // Preserve the FULL original options/signal separately. Only the old
        // wire observation is doc/variables; the actual SDK promise stays live.
        actualSdkOptions.push(first as (typeof actualSdkOptions)[number]);
        return requestMock(first.document, first.variables);
      }
      if (parameters.length === 2 || (parameters.length === 3 && parameters[2] === undefined))
        return requestMock(parameters[0], parameters[1]);
      throw new Error('Unsupported native SDK request overload');
    },
  }),
}));
vi.mock('@boardsesh/graphql/operations/proposals', () => ({
  GET_CLIMB_PROPOSALS: 'GET_CLIMB_PROPOSALS',
  BROWSE_PROPOSALS: 'BROWSE_PROPOSALS',
}));

import { climbProposalsKey } from '../use-browse-proposals';
import { useClimbProposals } from '../use-climb-proposals';
import { CLIMB_LOST_HOLDS_QUERY_KEY, useClimbLostHolds } from '../use-climb-lost-holds';

type QueryObservation = { context?: QueryFunctionContext; applicationSignalReads: number };
function makeWrapper(observation?: QueryObservation) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        ...(observation
          ? {
              persister: (queryFn, context) => {
                observation.context = context;
                return queryFn(
                  new Proxy(context, {
                    get(target, property, receiver) {
                      if (property === 'signal') observation.applicationSignalReads += 1;
                      return Reflect.get(target, property, receiver);
                    },
                  }),
                );
              },
            }
          : {}),
      },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const proposal = {
  uuid: 'hide-1',
  climbUuid: 'climb-1',
  boardType: 'kilter',
  angle: null,
  proposerId: 'user-1',
  type: 'hide',
  proposedValue: 'true',
  currentValue: 'false',
  status: 'open',
  reason: 'Duplicate',
  createdAt: '2026-09-01T10:00:00.000Z',
  weightedUpvotes: 2,
  weightedDownvotes: 0,
  requiredUpvotes: 5,
  userVote: 0,
  upvoterCount: 2,
  commentCount: 2,
} satisfies Proposal;

const response = { climbProposals: { proposals: [proposal], totalCount: 1, hasMore: false } };

describe('useClimbProposals', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(response);
  });

  it('hands callers the proposal array, not the connection', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual([proposal]));
  });

  it('caches the raw document under the feed key, so a feed vote reaches it', async () => {
    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The moderation feed's `mapCachedProposals` walks `{ climbProposals }`;
    // caching the unwrapped array here would make its rewrite a silent no-op.
    expect(queryClient.getQueryData(climbProposalsKey('climb-1'))).toEqual(response);
    expect(climbProposalsKey('climb-1')).toEqual(['proposals', 'climb', 'climb-1']);
  });

  it('asks for the climb, the board and one page', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'tension' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith('GET_CLIMB_PROPOSALS', {
      input: { climbUuid: 'climb-1', boardType: 'tension', limit: 20 },
    });
  });

  it('stays idle when the caller disables it (kill flag off)', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter', enabled: false }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not fire without a climb uuid', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: '', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('native finite climb reader lifetime compatibility', () => {
  const variables = {
    boardName: 'spray',
    layoutId: 7,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    climbUuid: 'climb-1',
  } as const;
  const lostResponse = {
    climb: { lostHolds: [{ id: 2, cx: 100, cy: 100, r: 10, outline: null }] },
  };

  it('finishes a native proposal request after unmount and caches the raw document under the original key', async () => {
    let complete!: (result: typeof response) => void;
    const held = new Promise<typeof response>((resolve) => {
      complete = resolve;
    });
    requestMock.mockReset().mockReturnValue(held);
    actualSdkOptions.length = 0;
    const observation: QueryObservation = { applicationSignalReads: 0 };
    const { queryClient, Wrapper } = makeWrapper(observation);
    const view = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });
    try {
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      const key = climbProposalsKey('climb-1');
      const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
      expect(query?.promise).toBeDefined();
      const settled = query!.promise!.then(
        () => 'resolved',
        () => 'rejected',
      );
      const sdk = actualSdkOptions.at(-1)!;
      expect(Object.keys(sdk).sort()).toEqual(['document', 'requestHeaders', 'signal', 'variables']);
      expect(sdk.document).toBe('GET_CLIMB_PROPOSALS');
      expect(sdk.variables).toEqual({ input: { climbUuid: 'climb-1', boardType: 'kilter', limit: 20 } });
      expect(sdk.requestHeaders).toBeUndefined();
      expect(sdk.signal.aborted).toBe(false);
      expect(observation.applicationSignalReads).toBe(0);
      view.unmount();
      expect(sdk.signal.aborted).toBe(false);
      await act(async () => {
        complete(response);
        await settled;
      });
      expect(await settled).toBe('resolved');
      expect(observation.applicationSignalReads).toBe(0);
      // Inspect the original Query getter only AFTER settlement. This cannot
      // cancel the held request or conceal an application getter read above.
      expect(observation.context).toBeDefined();
      const querySignal = observation.context!.signal;
      expect(sdk.signal).not.toBe(querySignal);
      expect(querySignal.aborted).toBe(false);
      expect(sdk.signal.aborted).toBe(true);
      expect(queryClient.getQueryData(key)).toEqual(response);
      expect(key).toEqual(['proposals', 'climb', 'climb-1']);
      expect(requestMock).toHaveBeenCalledTimes(1);
    } finally {
      complete(response);
      view.unmount();
      queryClient.clear();
    }
  });

  it('dispatches the native lost-holds read while offline and stops after its one retry', async () => {
    const previousOnline = onlineManager.isOnline();
    // Only retry timing is accelerated; the hook must supply its own retry1
    // over this client's defaultfalse and its original networkModealways.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    requestMock.mockReset().mockRejectedValue(new Error('Owned native offline response'));
    onlineManager.setOnline(false);
    const view = renderHook(() => useClimbLostHolds(variables), { wrapper: Wrapper });
    try {
      await waitFor(() => expect(view.result.current.status).toBe('unavailable'));
      expect(requestMock).toHaveBeenCalledTimes(2);
      const state = queryClient.getQueryState([...CLIMB_LOST_HOLDS_QUERY_KEY, variables]);
      expect(state?.fetchStatus).toBe('idle');
      expect(state?.status).toBe('error');
    } finally {
      view.unmount();
      queryClient.clear();
      onlineManager.setOnline(previousOnline);
    }
  });

  it('finishes a native lost-holds request after unmount without replacing its raw cache envelope', async () => {
    let complete!: (result: typeof lostResponse) => void;
    const held = new Promise<typeof lostResponse>((resolve) => {
      complete = resolve;
    });
    requestMock.mockReset().mockReturnValue(held);
    actualSdkOptions.length = 0;
    const observation: QueryObservation = { applicationSignalReads: 0 };
    const { queryClient, Wrapper } = makeWrapper(observation);
    const view = renderHook(() => useClimbLostHolds(variables), { wrapper: Wrapper });
    try {
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      const key = [...CLIMB_LOST_HOLDS_QUERY_KEY, variables];
      const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
      expect(query?.promise).toBeDefined();
      const settled = query!.promise!.then(
        () => 'resolved',
        () => 'rejected',
      );
      const sdk = actualSdkOptions.at(-1)!;
      expect(Object.keys(sdk).sort()).toEqual(['document', 'requestHeaders', 'signal', 'variables']);
      expect(sdk.document).toBe(GET_CLIMB_LOST_HOLDS);
      expect(sdk.variables).toEqual(variables);
      expect(sdk.requestHeaders).toBeUndefined();
      expect(sdk.signal.aborted).toBe(false);
      expect(observation.applicationSignalReads).toBe(0);
      view.unmount();
      expect(sdk.signal.aborted).toBe(false);
      await act(async () => {
        complete(lostResponse);
        await settled;
      });
      expect(await settled).toBe('resolved');
      expect(observation.applicationSignalReads).toBe(0);
      expect(observation.context).toBeDefined();
      const querySignal = observation.context!.signal;
      expect(sdk.signal).not.toBe(querySignal);
      expect(querySignal.aborted).toBe(false);
      expect(sdk.signal.aborted).toBe(true);
      expect(queryClient.getQueryData(key)).toEqual(lostResponse);
      expect(requestMock).toHaveBeenCalledTimes(1);
    } finally {
      complete(lostResponse);
      view.unmount();
      queryClient.clear();
    }
  });
});
