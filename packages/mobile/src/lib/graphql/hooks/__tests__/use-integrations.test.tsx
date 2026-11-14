// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { GET_INTEGRATIONS, type GetIntegrationsResponse } from '@boardsesh/graphql/operations/integrations';

const host = vi.hoisted(() => ({ authenticated: true, request: vi.fn(), track: vi.fn() }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: host.authenticated }) }));
vi.mock('../../../analytics', () => ({ track: host.track }));
vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: ({ document, variables }: { document: unknown; variables?: unknown }) => host.request(document, variables),
  }),
  getOfflineSyncHttpClient: vi.fn(),
}));
import {
  useDisconnectIntegration,
  useIntegrationStatuses,
  useSetIntegrationAutoSync,
  useSyncSessionToIntegration,
} from '../use-integrations';

const key = ['integrationStatuses'];
const closeFixtures: (() => void)[] = [];
beforeEach(() => {
  host.authenticated = true;
  host.request.mockReset();
  host.track.mockReset();
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
});
function fixture() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => cache.clear());
  return { cache, wrapper };
}
function statuses(enabled = false): GetIntegrationsResponse {
  return {
    integrations: [
      { provider: 'STRAVA', connected: true, autoSyncEnabled: enabled, externalAccountName: 'Owned athlete' },
    ],
  };
}

describe('native integration hooks preserve their business behavior', () => {
  it('keeps signed-out status reads idle', async () => {
    host.authenticated = false;
    const current = fixture();
    const { result } = renderHook(useIntegrationStatuses, current);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(host.request).not.toHaveBeenCalled();
  });

  it('unwraps statuses while retaining the native query key and document', async () => {
    const current = fixture();
    host.request.mockResolvedValue(statuses());
    const { result } = renderHook(useIntegrationStatuses, current);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(statuses().integrations);
    expect(current.cache.getQueryData(key)).toEqual(statuses());
    expect(host.request).toHaveBeenCalledWith(GET_INTEGRATIONS, undefined);
  });

  it('keeps disconnect refetch nonblocking and tracks the actual provider', async () => {
    const current = fixture();
    host.request.mockResolvedValue({ disconnectIntegration: true });
    let release!: () => void;
    vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(useDisconnectIntegration, current);
    await act(async () => {
      await result.current.mutateAsync({ provider: 'STRAVA' });
    });
    expect(host.track).toHaveBeenCalledWith(SHARED_EVENTS.IntegrationDisconnected, { integration: 'strava' });
    await act(async () => {
      release();
    });
  });

  it('optimistically flips auto-sync and restores the original snapshot on failure', async () => {
    const current = fixture();
    current.cache.setQueryData(key, statuses());
    let refuse!: (reason: Error) => void;
    host.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const invalidate = vi.spyOn(current.cache, 'invalidateQueries');
    const { result } = renderHook(useSetIntegrationAutoSync, current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
    });
    const refused = expect(pending).rejects.toThrow('Owned upstream refusal');
    await waitFor(() => expect(current.cache.getQueryData(key)).toEqual(statuses(true)));
    await act(async () => {
      refuse(new Error('Owned upstream refusal'));
      await refused;
    });
    expect(current.cache.getQueryData(key)).toEqual(statuses());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(host.track).not.toHaveBeenCalled();
  });

  it('keeps the successful auto-sync update and provider attribution', async () => {
    const current = fixture();
    current.cache.setQueryData(key, statuses());
    host.request.mockResolvedValue({ setIntegrationAutoSync: statuses(true).integrations[0] });
    const { result } = renderHook(useSetIntegrationAutoSync, current);
    await act(async () => {
      await result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
    });
    expect(current.cache.getQueryData(key)).toEqual(statuses(true));
    expect(host.track).toHaveBeenCalledWith(SHARED_EVENTS.IntegrationAutoSyncToggled, {
      integration: 'strava',
      enabled: true,
    });
  });

  it('does not invent an optimistic status when no snapshot exists', async () => {
    const current = fixture();
    host.request.mockResolvedValue({ setIntegrationAutoSync: statuses(true).integrations[0] });
    const { result } = renderHook(useSetIntegrationAutoSync, current);
    await act(async () => {
      await result.current.mutateAsync({ provider: 'STRAVA', enabled: true });
    });
    expect(current.cache.getQueryData(key)).toBeUndefined();
  });

  it('keeps domain export errors available to the caller without success analytics', async () => {
    const current = fixture();
    const response = {
      syncSessionToIntegration: { provider: 'STRAVA', sessionId: 'owned-session', error: 'not_connected' },
    };
    host.request.mockResolvedValue(response);
    const { result } = renderHook(useSyncSessionToIntegration, current);
    await act(async () => {
      expect(await result.current.mutateAsync({ provider: 'STRAVA', sessionId: 'owned-session' })).toEqual(response);
    });
    expect(host.track).not.toHaveBeenCalled();
  });

  it('tracks a successful manual export', async () => {
    const current = fixture();
    host.request.mockResolvedValue({
      syncSessionToIntegration: { provider: 'STRAVA', sessionId: 'owned-session', error: null },
    });
    const { result } = renderHook(useSyncSessionToIntegration, current);
    await act(async () => {
      await result.current.mutateAsync({ provider: 'STRAVA', sessionId: 'owned-session' });
    });
    expect(host.track).toHaveBeenCalledWith(SHARED_EVENTS.SessionExportedToIntegration, {
      integration: 'strava',
      trigger: 'manual',
    });
  });
});
