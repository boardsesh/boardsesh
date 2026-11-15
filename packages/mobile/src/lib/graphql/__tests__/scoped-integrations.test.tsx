// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_INTEGRATIONS, type GetIntegrationsResponse } from '@boardsesh/graphql/operations/integrations';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null, authenticated: true, track: vi.fn() }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned integrations fixture');
    return selected.scope;
  },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: selected.authenticated }) }));
vi.mock('../../analytics', () => ({ track: selected.track }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import {
  useDisconnectIntegration,
  useIntegrationStatuses,
  useSetIntegrationAutoSync,
  useSyncSessionToIntegration,
} from '../hooks/use-integrations';

const key = ['integrationStatuses'];
const closeFixtures: (() => void)[] = [];
beforeEach(() => {
  selected.authenticated = true;
  selected.track.mockReset();
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
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
function statuses(owner = 'A', enabled = false): GetIntegrationsResponse {
  return {
    integrations: [{ provider: 'STRAVA', connected: true, autoSyncEnabled: enabled, externalAccountName: owner }],
  };
}
function heldResponse(envelope: unknown) {
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
function useIntegrationWrites() {
  return {
    disconnect: useDisconnectIntegration(),
    auto: useSetIntegrationAutoSync(),
    sync: useSyncSessionToIntegration(),
  };
}
function successfulWrites() {
  return {
    disconnectIntegration: true,
    setIntegrationAutoSync: statuses('A', true).integrations[0],
    syncSessionToIntegration: { provider: 'STRAVA', sessionId: 'owned-session', error: null },
  };
}

describe('actual scoped integration HTTP consumers', () => {
  it.each(['B', 'ABA'] as const)('cannot fill the new %s status key from an older account body', async (change) => {
    const current = fixture();
    const original = selected.scope!;
    const held = heldResponse({ data: statuses('old-A') });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result, rerender } = renderHook(useIntegrationStatuses, current);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async () => Response.json({ data: statuses('fresh-owner') }));
    rerender();
    await waitFor(() => expect(result.current.data?.[0].externalAccountName).toBe('fresh-owner'));
    await act(async () => {
      held.release();
    });
    expect(result.current.data?.[0].externalAccountName).toBe('fresh-owner');
    expect(current.cache.getQueryData(original.key(key))).toBeUndefined();
    expect(current.cache.getQueryData(key)).toBeUndefined();
  });

  it.each(['signed-out', 'unavailable'] as const)('keeps status reads idle when %s', async (state) => {
    const current = fixture();
    if (state === 'signed-out') selected.authenticated = false;
    else selected.scope = Object.freeze({ ...selected.scope!, isReady: () => false });
    const { result } = renderHook(useIntegrationStatuses, current);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA'] as const)(
    'captures auto-sync before held cancellation and refuses %s without sending',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      current.cache.setQueryData(original.key(key), statuses());
      let release!: () => void;
      const cancel = vi.spyOn(current.cache, 'cancelQueries').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { result, rerender } = renderHook(useSetIntegrationAutoSync, current);
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
      });
      const refused = expect(pending).rejects.toThrow();
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      current.cache.setQueryData(selected.scope.key(key), statuses('fresh-owner', true));
      rerender();
      await act(async () => {
        release();
        await refused;
      });
      expect(current.cache.getQueryData(original.key(key))).toEqual(statuses());
      expect(current.cache.getQueryData(selected.scope.key(key))).toEqual(statuses('fresh-owner', true));
      expect(current.performFetch).not.toHaveBeenCalled();
      expect(current.issueLease).not.toHaveBeenCalled();
      expect(selected.track).not.toHaveBeenCalled();
    },
  );

  it.each(['B', 'ABA'] as const)('does not roll an older failed optimistic write into %s', async (change) => {
    const current = fixture();
    const original = selected.scope!;
    current.cache.setQueryData(original.key(key), statuses());
    const held = heldResponse({ errors: [{ message: 'Owned upstream refusal' }] });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result, rerender } = renderHook(useSetIntegrationAutoSync, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
    });
    const refused = expect(pending).rejects.toThrow();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    expect(current.cache.getQueryData(original.key(key))).toEqual(statuses('A', true));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.cache.setQueryData(selected.scope.key(key), statuses('fresh-owner', true));
    rerender();
    await act(async () => {
      held.release();
      await refused;
    });
    expect(current.cache.getQueryData(selected.scope.key(key))).toEqual(statuses('fresh-owner', true));
    expect(current.cache.getQueryData(original.key(key))).toEqual(statuses('A', true));
    expect(current.cache.getQueryData(key)).toBeUndefined();
    expect(selected.track).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'auto', 'sync'] as const)(
    'does not publish delayed %s success analytics after B or expiry',
    async (kind) => {
      for (const change of ['B', 'expired'] as const) {
        const current = fixture();
        const original = selected.scope!;
        current.cache.setQueryData(original.key(key), statuses());
        const held = heldResponse({ data: successfulWrites() });
        current.performFetch.mockResolvedValueOnce(held.response);
        const { result, rerender, unmount } = renderHook(useIntegrationWrites, current);
        let pending!: Promise<unknown>;
        act(() => {
          pending =
            kind === 'disconnect'
              ? result.current.disconnect.mutateAsync({ provider: 'STRAVA' })
              : kind === 'auto'
                ? result.current.auto.mutateAsync({ provider: 'STRAVA', enabled: true })
                : result.current.sync.mutateAsync({ provider: 'STRAVA', sessionId: 'owned-session' });
        });
        const refused = expect(pending).rejects.toThrow();
        await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
        if (change === 'B') {
          current.switchAccount('owned-B');
          selected.scope = current.scope();
          current.cache.setQueryData(selected.scope.key(key), statuses('fresh-owner', true));
          rerender();
        } else current.clock(120_001);
        await act(async () => {
          held.release();
          await refused;
        });
        expect(selected.track).not.toHaveBeenCalled();
        if (change === 'B')
          expect(current.cache.getQueryData(selected.scope!.key(key))).toEqual(statuses('fresh-owner', true));
        expect(current.cache.getQueryData(key)).toBeUndefined();
        unmount();
      }
    },
  );

  it('keeps successful optimistic writes and settle invalidation in the original prefix', async () => {
    const current = fixture();
    const original = selected.scope!;
    current.cache.setQueryData(original.key(key), statuses());
    current.performFetch.mockResolvedValueOnce(Response.json({ data: successfulWrites() }));
    const invalidate = vi.spyOn(current.cache, 'invalidateQueries');
    const { result } = renderHook(useSetIntegrationAutoSync, current);
    await act(async () => {
      await result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
    });
    expect(current.cache.getQueryData(original.key(key))).toEqual(statuses('A', true));
    expect(current.cache.getQueryData(key)).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: original.key(key) });
    expect(selected.track).toHaveBeenCalledTimes(1);
  });

  it('rolls back a current-view error and reconciles only that original view', async () => {
    const current = fixture();
    const original = selected.scope!;
    current.cache.setQueryData(original.key(key), statuses());
    current.performFetch.mockResolvedValueOnce(Response.json({ errors: [{ message: 'Owned upstream refusal' }] }));
    const invalidate = vi.spyOn(current.cache, 'invalidateQueries');
    const { result } = renderHook(useSetIntegrationAutoSync, current);
    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'STRAVA', enabled: true })).rejects.toThrow();
    });
    expect(current.cache.getQueryData(original.key(key))).toEqual(statuses());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: original.key(key) });
    expect(selected.track).not.toHaveBeenCalled();
  });

  it('rechecks disconnect delivery after an external invalidation synchronously changes the view', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json({ data: successfulWrites() }));
    vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(async () => {
      current.switchAccount('owned-B');
    });
    const { result } = renderHook(useDisconnectIntegration, current);
    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'STRAVA' })).rejects.toThrow();
    });
    expect(selected.track).not.toHaveBeenCalled();
  });

  it('cannot borrow a newer same-owner delivery when disconnect invalidation outlives its original lease', async () => {
    const current = fixture();
    const held = heldResponse({ data: successfulWrites() });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result } = renderHook(useDisconnectIntegration, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ provider: 'STRAVA' });
    });
    const refused = expect(pending).rejects.toThrow();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.clock(90_000);
    current.performFetch.mockImplementation(async () => Response.json({ data: statuses() }));
    const newer = await selected.scope!.run((operation) =>
      operation.request<GetIntegrationsResponse>(GET_INTEGRATIONS),
    );
    vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(async () => {
      current.clock(120_001);
    });
    await act(async () => {
      held.release();
      await refused;
    });
    newer.assertCurrent();
    expect(selected.track).not.toHaveBeenCalled();
  });
});
