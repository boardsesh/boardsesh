// @vitest-environment jsdom
// Delivery metadata is covered by offline-write-context.test.ts; keep these unit tests native-free.
vi.mock('../../../../offline/offline-write-context', () => ({
  readOfflineWriteRelease: () => ({
    platform: 'ios',
    appVersion: null,
    runtimeVersion: null,
    updateId: null,
    isEmbedded: null,
    branch: null,
  }),
  enqueueMeasuredMutation: async (...args: Parameters<typeof import('@boardsesh/offline-sync').enqueue>) =>
    (await import('@boardsesh/offline-sync')).enqueue(...args),
}));

/**
 * Social reads and writes outlive their screen on phones (#7596 A4, the
 * reverts of #7549 and #7554).
 *
 * The profile, follower, following, people search, comment and vote summary
 * reads are plain useQuery/useInfiniteQuery again: they never read TanStack's
 * abort signal, so a profile or comment sheet closed mid-fetch still fills the
 * cache. A vote or a comment sent just before its row or sheet goes away still
 * reaches the server and edits the cache, and the comment send frees its button
 * as soon as the comment lands instead of waiting for the thread to refetch.
 *
 * Real HTTP through a local node:http server; see helpers/held-graphql-server.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHeldGraphQLServer,
  createScreenHost,
  expectReadOutlivesScreen,
  settleAfterUnmount,
  type ReadCase,
} from '../../__tests__/helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
// use-social's follow helpers read the stored user id and the offline database
// at import; neither is on the path of the reads and writes below.
vi.mock('../../../local-user-id', () => ({ readLocalUserId: async () => 'me' }));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'me', isLoading: false }),
}));
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => null }));
// useOptimisticVote imports useVote through the hooks barrel; hand it the real one.
vi.mock('../index', async () => ({ useVote: (await import('../use-social')).useVote }));

import {
  useAddComment,
  useBulkVoteSummaries,
  useComments,
  useFollowers,
  useFollowing,
  usePublicProfile,
  useSearchUsers,
} from '../use-social';
import { useOptimisticVote } from '../../../../components/you/use-optimistic-vote';

const server = createHeldGraphQLServer();

beforeAll(async () => {
  transport.client = await server.start();
});

afterEach(() => {
  server.releaseAll();
});

afterAll(async () => {
  transport.client = null;
  await server.stop();
});

const PROFILE = { id: 'user-1', displayName: 'Ana', followerCount: 3, followingCount: 4, isFollowedByMe: false };
const FOLLOW_PAGE = { users: [], totalCount: 0, hasMore: false };
const SEARCH_PAGE = { results: [], totalCount: 0, hasMore: false };
const COMMENTS = { comments: [], totalCount: 0, hasMore: false };
const SUMMARY = { entityType: 'session', entityId: 'session-1', upvotes: 5, downvotes: 0, voteScore: 5, userVote: 0 };

const READS: ReadCase[] = [
  {
    name: 'public profile',
    operationName: 'GetPublicProfile',
    queryKey: ['publicProfile', 'user-1'],
    data: { publicProfile: PROFILE },
    cached: PROFILE,
    mount: () => usePublicProfile('user-1'),
  },
  {
    name: 'followers',
    operationName: 'GetFollowers',
    queryKey: ['followers', 'user-1'],
    data: { followers: FOLLOW_PAGE },
    cached: { pages: [FOLLOW_PAGE], pageParams: [0] },
    mount: () => useFollowers('user-1'),
  },
  {
    name: 'following',
    operationName: 'GetFollowing',
    queryKey: ['following', 'user-1'],
    data: { following: FOLLOW_PAGE },
    cached: { pages: [FOLLOW_PAGE], pageParams: [0] },
    mount: () => useFollowing('user-1'),
  },
  {
    name: 'people search',
    operationName: 'SearchUsers',
    queryKey: ['searchUsers', 'ana'],
    data: { searchUsers: SEARCH_PAGE },
    cached: { pages: [SEARCH_PAGE], pageParams: [0] },
    mount: () => useSearchUsers('ana'),
  },
  {
    name: 'comments',
    operationName: 'GetComments',
    queryKey: ['comments', 'session', 'session-1'],
    data: { comments: COMMENTS },
    cached: COMMENTS,
    mount: () => useComments('session', 'session-1'),
  },
  {
    name: 'vote summaries',
    operationName: 'GetBulkVoteSummaries',
    queryKey: ['bulkVoteSummaries', 'session', ['session-1']],
    data: { bulkVoteSummaries: [SUMMARY] },
    cached: [SUMMARY],
    mount: () => useBulkVoteSummaries('session', ['session-1']),
  },
];

describe('native social reads outlive the screen that started them', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    await expectReadOutlivesScreen(server, read);
  });
});

describe('native social writes outlive the screen that started them', () => {
  it('vote: the server gets it and the vote summary cache takes the answer after the row unmounts', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const summaryKey = ['bulkVoteSummaries', 'session', ['session-1']];
    queryClient.setQueryData(summaryKey, [SUMMARY]);

    const row = renderHook(() => useOptimisticVote('session-1', 5, null), { wrapper });
    act(() => row.result.current.toggle());
    const held = await server.nextHeldRequest('Vote');
    expect(held.variables).toEqual({ input: { entityType: 'session', entityId: 'session-1', value: 1 } });

    row.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    const answered = { ...SUMMARY, upvotes: 6, voteScore: 6, userVote: 1 };
    held.answer({ vote: answered });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    expect(queryClient.getQueryData(summaryKey)).toEqual([answered]);
    expect(server.countOf('Vote')).toBe(1);
  });

  it('comment: the server gets it and the thread is marked stale after the sheet unmounts', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const threadKey = ['comments', 'session', 'session-1'];
    queryClient.setQueryData(threadKey, COMMENTS);

    const sheet = renderHook(() => useAddComment(), { wrapper });
    act(() => sheet.result.current.mutate({ entityType: 'session', entityId: 'session-1', body: 'nice send' }));
    const held = await server.nextHeldRequest('AddComment');

    sheet.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ addComment: { uuid: 'comment-1', body: 'nice send' } });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(server.countOf('AddComment')).toBe(1);
  });

  it('comment: the send frees as soon as the comment lands, before the thread refetch answers', async () => {
    const { wrapper } = createScreenHost();
    const sheet = renderHook(() => ({ thread: useComments('session', 'session-1'), send: useAddComment() }), {
      wrapper,
    });
    (await server.nextHeldRequest('GetComments')).answer({ comments: COMMENTS });
    await waitFor(() => expect(sheet.result.current.thread.isSuccess).toBe(true));

    act(() => sheet.result.current.send.mutate({ entityType: 'session', entityId: 'session-1', body: 'nice send' }));
    (await server.nextHeldRequest('AddComment')).answer({ addComment: { uuid: 'comment-1', body: 'nice send' } });

    // The invalidation refetches the open thread; the server holds that answer.
    await waitFor(() => expect(server.countOf('GetComments')).toBe(2));
    await waitFor(() => expect(sheet.result.current.send.isPending).toBe(false));
    expect(sheet.result.current.send.isSuccess).toBe(true);
    sheet.unmount();
  });
});
