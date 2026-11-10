// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => auth }));

import { usePartnerAppsEnabled } from '../use-connected-apps';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

/** One app session: one cache, read by however many editor opens the test mounts. */
function createSession() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    /** Mounts the hook like an editor opening, and resolves with its settled answer. */
    async open(): Promise<boolean> {
      const { result, unmount } = renderHook(() => usePartnerAppsEnabled(), { wrapper });
      await waitFor(() => expect(client.isFetching()).toBe(0));
      const answer = result.current;
      unmount();
      return answer;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  request.mockReset();
  auth.isAuthenticated = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePartnerAppsEnabled', () => {
  it('asks once, then answers every editor open within the hour from the cache', async () => {
    request.mockResolvedValue({ partnerAppsEnabled: true });
    const session = createSession();
    expect(await session.open()).toBe(true);
    vi.setSystemTime(NOW + 59 * 60_000);
    expect(await session.open()).toBe(true);
    expect(await session.open()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + HOUR_MS + 1);
    expect(await session.open()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('says no while partner apps are off', async () => {
    request.mockResolvedValue({ partnerAppsEnabled: false });
    expect(await createSession().open()).toBe(false);
  });

  it('fails closed offline or on an error, and asks again only an hour later', async () => {
    request.mockRejectedValue(new Error('Network request failed'));
    const session = createSession();
    expect(await session.open()).toBe(false);
    expect(await session.open()).toBe(false);
    vi.setSystemTime(NOW + 30 * 60_000);
    expect(await session.open()).toBe(false);
    // A broken backend costs one request an hour, not one per open.
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValue({ partnerAppsEnabled: true });
    vi.setSystemTime(NOW + HOUR_MS + 1);
    expect(await session.open()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('asks nothing while signed out, and says no', async () => {
    auth.isAuthenticated = false;
    expect(await createSession().open()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
