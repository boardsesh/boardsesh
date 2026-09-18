// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { GET_CREW_FEED } from '@boardsesh/graphql/operations';
import { useCrewFeed } from '../use-crew-feed';

const request = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ userId: 'viewer' as string | undefined }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../../hooks/use-current-user-id', () => ({ useStoredUserId: () => identity }));
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  request.mockReset();
  identity.userId = 'viewer';
});

// The hook resolves the device zone once at module load; the test env's is
// whatever TZ vitest runs under, so assert against the same source rather than
// pinning a zone the CI box may not share.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

describe('useCrewFeed', () => {
  it('pages with the backend cursor, carrying the viewer zone and no board or gym filters', async () => {
    request.mockResolvedValueOnce({ crewFeed: { items: [], cursor: 'next-cursor', hasMore: true } });
    request.mockResolvedValueOnce({ crewFeed: { items: [], cursor: null, hasMore: false } });
    const { result } = renderHook(() => useCrewFeed(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenLastCalledWith(GET_CREW_FEED, {
      input: { limit: 20, cursor: null, timeZone, groupClimbs: true },
    });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(request).toHaveBeenLastCalledWith(GET_CREW_FEED, {
      input: { limit: 20, cursor: 'next-cursor', timeZone, groupClimbs: true },
    });
  });
  it('does not request a private crew feed without a viewer', () => {
    identity.userId = undefined;
    renderHook(() => useCrewFeed(true), { wrapper });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not request Crew while another feed mode is enabled', () => {
    renderHook(() => useCrewFeed(false), { wrapper });
    expect(request).not.toHaveBeenCalled();
  });
});
