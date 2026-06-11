import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VOTE,
  GET_COMMENTS,
  ADD_COMMENT,
  GET_BULK_VOTE_SUMMARIES,
  GET_PUBLIC_PROFILE,
  GET_FOLLOWERS,
  GET_FOLLOWING,
  SEARCH_USERS,
  FOLLOW_USER,
  UNFOLLOW_USER,
  type VoteMutationResponse,
  type VoteMutationVariables,
  type GetCommentsQueryResponse,
  type AddCommentMutationResponse,
  type AddCommentMutationVariables,
  type GetBulkVoteSummariesQueryResponse,
  type GetPublicProfileQueryResponse,
  type GetFollowersQueryResponse,
  type GetFollowingQueryResponse,
  type SearchUsersQueryResponse,
  type FollowUserMutationResponse,
  type FollowUserMutationVariables,
  type UnfollowUserMutationResponse,
  type UnfollowUserMutationVariables,
} from '@boardsesh/graphql/operations';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

const SOCIAL_PAGE_SIZE = 30;

/** Public social profile for a user, including follower/following counts. */
export function usePublicProfile(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['publicProfile', userId],
    queryFn: async () => {
      const response = await getHttpClient().request<GetPublicProfileQueryResponse>(GET_PUBLIC_PROFILE, { userId });
      return response.publicProfile;
    },
    enabled: enabled && !!userId,
  });
}

/** Followers for a user profile, paginated by offset. */
export function useFollowers(userId: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['followers', userId],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<GetFollowersQueryResponse>(GET_FOLLOWERS, {
        input: { userId, limit: SOCIAL_PAGE_SIZE, offset: pageParam },
      });
      return response.followers;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.users.length, 0) : undefined,
    enabled: enabled && !!userId,
  });
}

/** Users a profile follows, paginated by offset. */
export function useFollowing(userId: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['following', userId],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<GetFollowingQueryResponse>(GET_FOLLOWING, {
        input: { userId, limit: SOCIAL_PAGE_SIZE, offset: pageParam },
      });
      return response.following;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.users.length, 0) : undefined,
    enabled: enabled && !!userId,
  });
}

/** Search Boardsesh users by display name. Disabled until the query has 2 chars. */
export function useSearchUsers(query: string, enabled = true) {
  const trimmedQuery = query.trim();

  return useInfiniteQuery({
    queryKey: ['searchUsers', trimmedQuery],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<SearchUsersQueryResponse>(SEARCH_USERS, {
        input: { query: trimmedQuery, limit: SOCIAL_PAGE_SIZE, offset: pageParam },
      });
      return response.searchUsers;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.results.length, 0) : undefined,
    enabled: enabled && trimmedQuery.length >= 2,
  });
}

export function useToggleUserFollow(currentUserId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, isFollowedByMe }: { userId: string; isFollowedByMe: boolean }) => {
      if (isFollowedByMe) {
        const variables: UnfollowUserMutationVariables = { input: { userId } };
        const response = await getHttpClient().request<UnfollowUserMutationResponse>(UNFOLLOW_USER, variables);
        return response.unfollowUser;
      }

      const variables: FollowUserMutationVariables = { input: { userId } };
      const response = await getHttpClient().request<FollowUserMutationResponse>(FOLLOW_USER, variables);
      return response.followUser;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['publicProfile', variables.userId] });
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: ['publicProfile', currentUserId] });
      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });
      void queryClient.invalidateQueries({ queryKey: ['searchUsers'] });
    },
  });
}

/**
 * Cast a vote on a social entity (e.g. a session). Returns the updated
 * VoteSummary so the caller can reflect the new count/`userVote` locally, and
 * patches any cached bulk-vote-summary lists so recycled / re-scrolled rows
 * (which reset their optimistic state on remount) stay in sync — no feed-wide
 * refetch needed.
 */
export function useVote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VoteMutationVariables['input']) => {
      const response = await getHttpClient().request<VoteMutationResponse>(VOTE, { input });
      return response.vote;
    },
    onSuccess: (summary) => {
      queryClient.setQueriesData<GetBulkVoteSummariesQueryResponse['bulkVoteSummaries']>(
        { queryKey: ['bulkVoteSummaries'] },
        (old) => old?.map((entry) => (entry.entityId === summary.entityId ? summary : entry)),
      );
    },
  });
}

/** Accurate vote state (count + `userVote`) for a batch of entities. */
export function useBulkVoteSummaries(entityType: SocialEntityType, entityIds: string[], enabled = true) {
  // Key off a sorted copy so the cache identity tracks the *set* of ids, not the
  // array order or reference. React Query hashes keys by value, so a fresh array
  // each render is already a cache hit — the sort additionally makes a reordered
  // (but identical) id list resolve to the same query instead of a refetch.
  const sortedIds = [...entityIds].sort();
  return useQuery({
    queryKey: ['bulkVoteSummaries', entityType, sortedIds],
    queryFn: async () => {
      const response = await getHttpClient().request<GetBulkVoteSummariesQueryResponse>(GET_BULK_VOTE_SUMMARIES, {
        input: { entityType, entityIds },
      });
      return response.bulkVoteSummaries;
    },
    enabled: enabled && entityIds.length > 0,
  });
}

/** Comment thread for a social entity. */
export function useComments(entityType: SocialEntityType, entityId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['comments', entityType, entityId],
    queryFn: async () => {
      const response = await getHttpClient().request<GetCommentsQueryResponse>(GET_COMMENTS, {
        input: { entityType, entityId },
      });
      return response.comments;
    },
    enabled: enabled && !!entityId,
  });
}

/** Add a comment, refreshing the thread + the session feed's comment counts. */
export function useAddComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddCommentMutationVariables['input']) => {
      const response = await getHttpClient().request<AddCommentMutationResponse>(ADD_COMMENT, { input });
      return response.addComment;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['comments', variables.entityType, variables.entityId] });
      void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
    },
  });
}
