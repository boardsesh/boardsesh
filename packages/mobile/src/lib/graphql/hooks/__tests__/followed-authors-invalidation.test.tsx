// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFollowedAuthors, useToggleAuthorFollow } from '../use-followed-authors';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../../hooks/use-current-user-id', () => ({ useStoredUserId: () => ({ userId: 'viewer' }) }));
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../offline-engine', () => ({ isOfflineEngineEnabled: () => false }));
const authors = { setterUsernames: ['accountless'], users: [] };

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ followedAuthors: authors });
});

describe('followed author invalidation', () => {
  it('does not invalidate feeds when another button mounts with cached authors', () => {
    const { client, invalidate, wrapper } = createHarness();
    client.setQueryData(['followedAuthors', 'viewer'], authors);
    renderHook(() => useFollowedAuthors(), { wrapper });
    renderHook(() => useFollowedAuthors(), { wrapper });
    expect(invalidate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('retries gated searches after the first author snapshot becomes available', async () => {
    const { invalidate, wrapper } = createHarness();
    const { result } = renderHook(() => useFollowedAuthors(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['crewFeed'] });
  });

  it('leaves user profile invalidation to the outer social mutation', async () => {
    const { invalidate, wrapper } = createHarness();
    const { result } = renderHook(() => useToggleAuthorFollow(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind: 'user', identifier: 'friend', follow: true });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['followedAuthors'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['publicProfile'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['following'] });
  });
});
