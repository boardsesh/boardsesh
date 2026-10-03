// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFollowedAuthors, useFollowedAuthorsSnapshot, useToggleAuthorFollow } from '../use-followed-authors';

const request = vi.hoisted(() => vi.fn());
const offline = vi.hoisted(() => ({ enabled: false, removedUserIds: [] as string[] }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/offline-sync')>()),
  assertLocalUserDataOwner: async () => 'ok',
}));
vi.mock('../../../../hooks/use-offline-mutations', () => ({
  writeAuthorFollowLocal: async () => offline.removedUserIds,
}));
vi.mock('../../../../offline/offline-sync-adapter', () => ({ drainMutationQueue: async () => {} }));
vi.mock('../../../../db/queries/followed-authors-local', () => ({
  readAuthorSnapshot: async () => ({ authors: { setterUsernames: [], users: [] }, incompleteUserIds: [] }),
}));
vi.mock('../../../local-user-id', () => ({ readLocalUserId: async () => 'viewer' }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../../hooks/use-current-user-id', () => ({ useStoredUserId: () => ({ userId: 'viewer' }) }));
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => (offline.enabled ? {} : null) }));
vi.mock('../../../offline-engine', () => ({ isOfflineEngineEnabled: () => offline.enabled }));
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
  offline.enabled = false;
  offline.removedUserIds = [];
  request.mockReset();
  request.mockResolvedValue({ followedAuthors: authors });
});

describe('followed author invalidation', () => {
  it('reconciles the linked user removed by a queued setter unfollow', async () => {
    offline.enabled = true;
    offline.removedUserIds = ['friend'];
    const { client, wrapper } = createHarness();
    client.setQueryData(['publicProfile', 'viewer'], { id: 'viewer', followingCount: 1 });
    client.setQueryData(['publicProfile', 'friend'], { id: 'friend', followerCount: 2, isFollowedByMe: true });
    client.setQueryData(['following', 'viewer'], {
      pages: [{ users: [{ id: 'friend', followerCount: 2, isFollowedByMe: true }], totalCount: 1, hasMore: false }],
      pageParams: [0],
    });
    const { result } = renderHook(() => useToggleAuthorFollow(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind: 'setter', identifier: 'linked', follow: false });
    });
    expect(client.getQueryData(['publicProfile', 'viewer'])).toMatchObject({ followingCount: 0 });
    expect(client.getQueryData(['publicProfile', 'friend'])).toMatchObject({ isFollowedByMe: false, followerCount: 1 });
    expect(client.getQueryData(['following', 'viewer'])).toMatchObject({ pages: [{ users: [], totalCount: 0 }] });
    expect(request).not.toHaveBeenCalled();
  });
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

  describe('the read-only snapshot the play drawer mounts', () => {
    it('reads cached authors without a request, however old they are', async () => {
      const { client, invalidate, wrapper } = createHarness();
      client.setQueryData(['followedAuthors', 'viewer'], authors, { updatedAt: Date.now() - 3_600_000 });
      const { result, rerender } = renderHook(
        ({ loadWhenMissing }) => useFollowedAuthorsSnapshot({ loadWhenMissing }),
        { wrapper, initialProps: { loadWhenMissing: false } },
      );
      rerender({ loadWhenMissing: true });
      await act(async () => {});

      expect(result.current.data).toEqual(authors);
      expect(request).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('loads a missing answer only once the caller says so', async () => {
      const { wrapper } = createHarness();
      const { result, rerender } = renderHook(
        ({ loadWhenMissing }) => useFollowedAuthorsSnapshot({ loadWhenMissing }),
        { wrapper, initialProps: { loadWhenMissing: false } },
      );
      await act(async () => {});
      expect(request).not.toHaveBeenCalled();

      rerender({ loadWhenMissing: true });
      await waitFor(() => expect(result.current.data).toEqual(authors));
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  // The play drawer's "Climber logs" card shows the logs of whoever you follow,
  // so every follow change has to drop what it cached.
  it.each([
    ['a user follow', 'user', true, false],
    ['a user unfollow', 'user', false, false],
    ['a queued user follow', 'user', true, true],
    ['a queued user unfollow', 'user', false, true],
    ['a setter follow', 'setter', true, false],
  ] as const)('drops cached climber logs after %s', async (_label, kind, follow, queued) => {
    offline.enabled = queued;
    const { invalidate, wrapper } = createHarness();
    const { result } = renderHook(() => useToggleAuthorFollow(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind, identifier: 'friend', follow });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['followingClimbLogs'] });
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
