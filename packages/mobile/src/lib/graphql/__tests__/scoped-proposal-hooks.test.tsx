// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Proposal } from '@boardsesh/shared-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope! }));
vi.mock('../use-auth-token', () => ({ useAuthToken: () => ({ data: 'unchanged-owned-token-label' }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../release-context', () => ({ readMobileReleaseContext: () => ({ channel: 'owned-test' }) }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import {
  browseProposalsKey,
  climbProposalsKey,
  useBrowseProposals,
  useClimbProposalsPinned,
} from '../hooks/use-browse-proposals';
import { useVoteOnProposal } from '../hooks/use-vote-on-proposal';
import { useResolveProposal } from '../hooks/use-resolve-proposal';
import { useReportClimb } from '../hooks/use-report-climb';
import { useProposalReportReleaseContexts } from '../hooks/use-proposal-report-release-contexts';

const closeFixtures: (() => void)[] = [];
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
  showToast.mockReset();
  vi.restoreAllMocks();
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}
function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    uuid: 'p1',
    climbUuid: 'c1',
    boardType: 'kilter',
    angle: 40,
    proposerId: 'u1',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    createdAt: '2026-09-01T10:00:00Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 0,
    ...overrides,
  } as Proposal;
}
const browseKey = browseProposalsKey({ boardType: null, status: null });
const pinnedKey = climbProposalsKey('c1');
function seed(cache: QueryClient, scope: HttpQueryScope, row = proposal()) {
  cache.setQueryData(scope.key(browseKey), { pages: [{ browseProposals: connection(row) }], pageParams: [0] });
  cache.setQueryData(scope.key(pinnedKey), { climbProposals: connection(row) });
}
function connection(row = proposal()) {
  return { proposals: [row], totalCount: 1, hasMore: false };
}
function rows(cache: QueryClient, scope: HttpQueryScope) {
  return [cache.getQueryData(scope.key(browseKey)), cache.getQueryData(scope.key(pinnedKey))];
}
function heldEnvelope(envelope: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function document(init: unknown) {
  return JSON.parse((init as RequestInit).body as string) as { query: string; variables: Record<string, unknown> };
}
function useReads() {
  return {
    browse: useBrowseProposals({ boardType: null, status: null }),
    pinned: useClimbProposalsPinned({ climbUuid: 'c1', boardType: 'kilter', enabled: true }),
  };
}
function useWrites() {
  return { vote: useVoteOnProposal(), resolve: useResolveProposal(), report: useReportClimb() };
}
const reportInput = { input: { climbUuid: 'c1', boardType: 'kilter', kind: 'hide', reason: 'unsafe' } } as const;

describe('actual selected proposal readers and moderation callbacks', () => {
  it.each(['B', 'ABA'] as const)('keeps delayed browse and pinned bodies out of the fresh %s cache', async (change) => {
    const current = fixture();
    const original = selected.scope!;
    const held: ReturnType<typeof heldEnvelope>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldEnvelope({
        data: document(init).query.includes('browseProposals')
          ? { browseProposals: connection(proposal({ uuid: 'old' })) }
          : { climbProposals: connection(proposal({ uuid: 'old' })) },
      });
      held.push(body);
      return body.response;
    });
    const { result, rerender } = renderHook(useReads, current);
    await waitFor(() => expect(held).toHaveLength(2));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({
        data: document(init).query.includes('browseProposals')
          ? { browseProposals: connection(proposal({ uuid: 'fresh' })) }
          : { climbProposals: connection(proposal({ uuid: 'fresh' })) },
      }),
    );
    rerender();
    await waitFor(() => expect(result.current.browse.data?.pages[0].browseProposals.proposals[0].uuid).toBe('fresh'));
    await waitFor(() => expect(result.current.pinned.data?.climbProposals.proposals[0].uuid).toBe('fresh'));
    await act(async () => {
      held.forEach((body) => body.release());
    });
    expect(rows(current.cache, original)).toEqual([undefined, undefined]);
    expect(JSON.stringify(rows(current.cache, selected.scope))).not.toContain('old');
    expect(current.cache.getQueryData(browseKey)).toBeUndefined();
  });

  it('retains confirmed-anonymous public reads, omitted null filters and exact pinned variables', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({
        data: document(init).query.includes('browseProposals')
          ? { browseProposals: connection() }
          : { climbProposals: connection() },
      }),
    );
    const { result } = renderHook(useReads, current);
    await waitFor(() => expect(result.current.browse.isSuccess && result.current.pinned.isSuccess).toBe(true));
    expect(current.issueLease).not.toHaveBeenCalled();
    const requests = current.performFetch.mock.calls.map(([, init]) => document(init));
    expect(requests.find((request) => request.query.includes('browseProposals'))?.variables).toEqual({
      input: { limit: 20, offset: 0 },
    });
    expect(requests.find((request) => request.query.includes('climbProposals'))?.variables).toEqual({
      input: { climbUuid: 'c1', boardType: 'kilter', limit: 20 },
    });
    for (const [, init] of current.performFetch.mock.calls)
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBeNull();
  });

  it('keeps required unavailable reads idle, including private expanded diagnostics', async () => {
    const current = fixture();
    selected.scope = Object.freeze({ ...selected.scope!, isReady: () => false });
    const { result } = renderHook(
      () => ({ ...useReads(), private: useProposalReportReleaseContexts('p1', true) }),
      current,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.browse.fetchStatus).toBe('idle');
    expect(result.current.pinned.fetchStatus).toBe('idle');
    expect(result.current.private).toBeUndefined();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA'] as const)(
    'refuses a vote held in cancelQueries before optimistic writes or dispatch under %s',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      seed(current.cache, original);
      let release!: () => void;
      vi.spyOn(current.cache, 'cancelQueries').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { result, rerender } = renderHook(useVoteOnProposal, current);
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
      });
      const refused = expect(pending).rejects.toThrow();
      await waitFor(() => expect(release).toBeTypeOf('function'));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      seed(current.cache, selected.scope, proposal({ weightedUpvotes: 40 }));
      const fresh = rows(current.cache, selected.scope);
      rerender();
      await act(async () => {
        release();
        await refused;
      });
      expect(current.performFetch).not.toHaveBeenCalled();
      expect(rows(current.cache, selected.scope)).toEqual(fresh);
      expect(JSON.stringify(rows(current.cache, original))).toContain('"userVote":0');
    },
  );

  it('uses only the original scoped browse and pinned caches for optimistic and weighted vote totals', async () => {
    const current = fixture();
    const original = selected.scope!;
    seed(current.cache, original);
    const unscoped = { climbProposals: connection(proposal({ weightedUpvotes: 99 })) };
    current.cache.setQueryData(pinnedKey, unscoped);
    const held = heldEnvelope({ data: { voteOnProposal: proposal({ userVote: 1, weightedUpvotes: 4 }) } });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result } = renderHook(useVoteOnProposal, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });
    await waitFor(() => expect(JSON.stringify(rows(current.cache, original))).toContain('"weightedUpvotes":2'));
    await act(async () => {
      held.release();
      await pending;
    });
    expect(
      rows(current.cache, original).every((cached) => JSON.stringify(cached).includes('"weightedUpvotes":4')),
    ).toBe(true);
    expect(current.cache.getQueryData(pinnedKey)).toEqual(unscoped);
  });

  it.each(['vote', 'resolve', 'report'] as const)(
    'refuses late %s success effects after B, ABA and original lease expiry',
    async (kind) => {
      for (const change of ['B', 'ABA', 'expired'] as const) {
        const current = fixture();
        const original = selected.scope!;
        seed(current.cache, original);
        const final = proposal({ status: 'approved', type: 'grade', weightedUpvotes: 50 });
        const held = heldEnvelope({
          data: { voteOnProposal: final, resolveProposal: final, reportClimb: { status: 'created', proposal: final } },
        });
        current.performFetch.mockResolvedValueOnce(held.response);
        const invalidations = vi.spyOn(current.cache, 'invalidateQueries').mockResolvedValue(undefined);
        const { result, rerender, unmount } = renderHook(useWrites, current);
        let pending!: Promise<unknown>;
        act(() => {
          pending =
            kind === 'vote'
              ? result.current.vote.mutateAsync({ proposalUuid: 'p1', value: 1 })
              : kind === 'resolve'
                ? result.current.resolve.mutateAsync({ proposalUuid: 'p1', status: 'approved' })
                : result.current.report.mutateAsync(reportInput);
        });
        const refused = expect(pending).rejects.toThrow();
        await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
        if (change === 'expired') {
          current.clock(90_000);
          await selected.scope!.run((operation) => operation.request('{ viewer { id } }'));
          current.clock(120_001);
        } else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
          selected.scope = current.scope();
          seed(current.cache, selected.scope, proposal({ weightedUpvotes: 80 }));
          rerender();
        }
        const fresh = rows(current.cache, selected.scope!);
        await act(async () => {
          held.release();
          await refused;
        });
        if (change !== 'expired') {
          expect(rows(current.cache, selected.scope!)).toEqual(fresh);
          expect(showToast).not.toHaveBeenCalled();
        }
        expect(JSON.stringify(rows(current.cache, original))).not.toContain('"weightedUpvotes":50');
        // Same-view failure reconciliation may invalidate proposals, never approved-climb effects.
        for (const [filters] of invalidations.mock.calls)
          expect(filters?.queryKey).toEqual(original.key(['proposals']));
        showToast.mockClear();
        unmount();
      }
    },
  );

  it('rolls back only the original vote view after a delayed failure without overwriting new B caches', async () => {
    const current = fixture();
    const original = selected.scope!;
    seed(current.cache, original);
    const held = heldEnvelope({ errors: [{ message: 'owned refusal' }] });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result, rerender } = renderHook(useVoteOnProposal, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });
    const refused = expect(pending).rejects.toThrow();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    selected.scope = current.scope();
    seed(current.cache, selected.scope, proposal({ weightedUpvotes: 80 }));
    const fresh = rows(current.cache, selected.scope);
    rerender();
    await act(async () => {
      held.release();
      await refused;
    });
    expect(rows(current.cache, selected.scope)).toEqual(fresh);
  });

  it('retries only the legacy releaseContext validation failure using the same captured operation', async () => {
    const current = fixture();
    current.performFetch
      .mockResolvedValueOnce(
        Response.json({ errors: [{ message: 'Field "releaseContext" is not defined by type "ReportClimbInput".' }] }),
      )
      .mockResolvedValueOnce(Response.json({ data: { reportClimb: { status: 'created', proposal: proposal() } } }));
    const { result } = renderHook(useReportClimb, current);
    await act(async () => {
      await result.current.mutateAsync(reportInput);
    });
    const requests = current.performFetch.mock.calls.map(([, init]) => document(init));
    expect(requests).toHaveLength(2);
    expect(requests[0].variables).toEqual({
      input: { ...reportInput.input, releaseContext: { channel: 'owned-test' } },
    });
    expect(requests[1].variables).toEqual(reportInput);
    expect(current.issueLease).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a legacy validation retry under a newer B view', async () => {
    const current = fixture();
    const held = heldEnvelope({
      errors: [{ message: 'Field "releaseContext" is not defined by type "ReportClimbInput".' }],
    });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result } = renderHook(useReportClimb, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync(reportInput);
    });
    const refused = expect(pending).rejects.toThrow();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    selected.scope = current.scope();
    await act(async () => {
      held.release();
      await refused;
    });
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['B', 'ABA'] as const)(
    'cleans only captured exact old private diagnostics when moving to %s, with auth label unchanged',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      current.performFetch.mockResolvedValueOnce(
        Response.json({ data: { proposalReportReleaseContexts: [{ commentUuid: 'old-A' }] } }),
      );
      const { result, rerender, unmount } = renderHook(() => useProposalReportReleaseContexts('p1', true), current);
      await waitFor(() => expect(result.current).toEqual([{ commentUuid: 'old-A' }]));
      const oldKey = current.cache
        .getQueryCache()
        .getAll()
        .find((query) => original.ownsKey(query.queryKey))!.queryKey;
      const suffix = oldKey.slice(-3);
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      const freshKey = selected.scope.key(suffix);
      const fresh = [{ commentUuid: 'fresh-owner' }];
      current.cache.setQueryData(freshKey, fresh);
      const held = heldEnvelope({ data: { proposalReportReleaseContexts: fresh } });
      current.performFetch.mockResolvedValueOnce(held.response);
      const remove = vi.spyOn(current.cache, 'removeQueries');
      const cancel = vi.spyOn(current.cache, 'cancelQueries');
      rerender();
      // Synchronous check precedes gcTime=0, so GC cannot stand in for the destructor.
      expect(current.cache.getQueryData(oldKey)).toBeUndefined();
      expect(current.cache.getQueryData(freshKey)).toEqual(fresh);
      expect(remove).toHaveBeenCalledWith({ queryKey: oldKey, exact: true });
      expect(cancel).toHaveBeenCalledWith({ queryKey: oldKey, exact: true });
      expect(remove.mock.calls.every(([filters]) => filters?.exact === true)).toBe(true);
      await act(async () => {
        held.release();
      });
      unmount();
    },
  );
});
