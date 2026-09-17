import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { updateUserFollowCaches } from '../user-follow-cache';

describe('offline user-follow display state', () => {
  it('updates profiles and paginated people without waiting for a network refetch', () => {
    const queryClient = new QueryClient();
    const person = { id: 'setter', followerCount: 2, followingCount: 3, isFollowedByMe: false };
    queryClient.setQueryData(['publicProfile', 'setter'], person);
    const connections = { pages: [{ users: [person], totalCount: 1, hasMore: false }], pageParams: [0] };
    queryClient.setQueryData(['following', 'viewer'], connections);
    queryClient.setQueryData(['followers', 'viewer'], connections);
    const search = {
      pages: [{ results: [{ user: person, recentAscentCount: 1 }], totalCount: 1, hasMore: false }],
      pageParams: [0],
    };
    queryClient.setQueryData(['searchUsers', 'set'], search);
    updateUserFollowCaches(queryClient, 'setter', true, 'viewer');
    expect(queryClient.getQueryData(['publicProfile', 'setter'])).toMatchObject({
      isFollowedByMe: true,
      followerCount: 3,
    });
    expect(
      queryClient.getQueryData<typeof connections>(['following', 'viewer'])?.pages[0].users[0].isFollowedByMe,
    ).toBe(true);
    expect(
      queryClient.getQueryData<typeof search>(['searchUsers', 'set'])?.pages[0].results[0].user.isFollowedByMe,
    ).toBe(true);
    updateUserFollowCaches(queryClient, 'setter', false, 'viewer');
    expect(queryClient.getQueryData(['publicProfile', 'setter'])).toEqual(person);
    queryClient.clear();
  });
  it('removes queued unfollows only from my list and updates my count once', () => {
    const queryClient = new QueryClient();
    const person = { id: 'setter', followerCount: 2, followingCount: 3, isFollowedByMe: true };
    const viewer = { id: 'viewer', followerCount: 1, followingCount: 2, isFollowedByMe: false };
    queryClient.setQueryData(['publicProfile', 'viewer'], viewer);
    queryClient.setQueryData(['publicProfile', 'setter'], person);
    const connections = { pages: [{ users: [person], totalCount: 2, hasMore: true }], pageParams: [0] };
    queryClient.setQueryData(['following', 'viewer'], connections);
    queryClient.setQueryData(['following', 'other'], connections);
    updateUserFollowCaches(queryClient, 'setter', false, 'viewer');
    updateUserFollowCaches(queryClient, 'setter', false, 'viewer');
    expect(queryClient.getQueryData(['publicProfile', 'viewer'])).toMatchObject({ followingCount: 1 });
    expect(queryClient.getQueryData<typeof connections>(['following', 'viewer'])?.pages[0]).toEqual({
      users: [],
      totalCount: 1,
      hasMore: true,
    });
    expect(queryClient.getQueryData<typeof connections>(['following', 'other'])?.pages[0].users).toHaveLength(1);
    updateUserFollowCaches(queryClient, 'setter', true, 'viewer');
    expect(queryClient.getQueryData(['publicProfile', 'viewer'])).toMatchObject({ followingCount: 2 });
    expect(queryClient.getQueryData<typeof connections>(['following', 'viewer'])?.pages[0].users).toHaveLength(1);
    queryClient.clear();
  });
});
