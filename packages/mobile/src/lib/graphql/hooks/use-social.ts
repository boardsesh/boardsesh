import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
  type GetPublicProfileQueryVariables,
  type GetFollowersQueryResponse,
  type GetFollowersQueryVariables,
  type GetFollowingQueryResponse,
  type GetFollowingQueryVariables,
  type SearchUsersQueryResponse,
  type SearchUsersQueryVariables,
  type FollowUserMutationResponse,
  type FollowUserMutationVariables,
  type UnfollowUserMutationResponse,
  type UnfollowUserMutationVariables,
  GET_USER_CLIMBS,
  type GetUserClimbsQueryResponse,
  type GetUserClimbsQueryVariables,
} from '@boardsesh/graphql/operations';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

const BULK_VOTE_SUMMARY_CHUNK_SIZE = 100;
const SOCIAL_PAGE_SIZE = 30;

function dedupeEntityIds(entityIds: string[]): string[] {
  const seenIds = new Set<string>();
  const dedupedIds: string[] = [];

  for (const entityId of entityIds) {
    if (seenIds.has(entityId)) continue;
    seenIds.add(entityId);
    dedupedIds.push(entityId);
  }

  return dedupedIds;
}

function chunkEntityIds(entityIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let startIndex = 0; startIndex < entityIds.length; startIndex += BULK_VOTE_SUMMARY_CHUNK_SIZE) {
    chunks.push(entityIds.slice(startIndex, startIndex + BULK_VOTE_SUMMARY_CHUNK_SIZE));
  }
  return chunks;
}

/** Public social profile for a user, including follower/following counts. */
export function usePublicProfile(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['publicProfile', userId],
    queryFn: async () => {
      if (!userId) throw new Error('Cannot load a public profile without a user id.');
      const variables: GetPublicProfileQueryVariables = { userId };
      const response = await getHttpClient().request<GetPublicProfileQueryResponse, GetPublicProfileQueryVariables>(
        GET_PUBLIC_PROFILE,
        variables,
      );
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
      if (!userId) throw new Error('Cannot load followers without a user id.');
      const variables: GetFollowersQueryVariables = {
        input: { userId, limit: SOCIAL_PAGE_SIZE, offset: Number(pageParam) },
      };
      const response = await getHttpClient().request<GetFollowersQueryResponse, GetFollowersQueryVariables>(
        GET_FOLLOWERS,
        variables,
      );
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
      if (!userId) throw new Error('Cannot load following without a user id.');
      const variables: GetFollowingQueryVariables = {
        input: { userId, limit: SOCIAL_PAGE_SIZE, offset: Number(pageParam) },
      };
      const response = await getHttpClient().request<GetFollowingQueryResponse, GetFollowingQueryVariables>(
        GET_FOLLOWING,
        variables,
      );
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
      if (trimmedQuery.length < 2) throw new Error('Cannot search users with fewer than 2 characters.');
      const variables: SearchUsersQueryVariables = {
        input: { query: trimmedQuery, limit: SOCIAL_PAGE_SIZE, offset: Number(pageParam) },
      };
      const response = await getHttpClient().request<SearchUsersQueryResponse, SearchUsersQueryVariables>(
        SEARCH_USERS,
        variables,
      );
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
        const response = await getHttpClient().request<UnfollowUserMutationResponse, UnfollowUserMutationVariables>(
          UNFOLLOW_USER,
          variables,
        );
        return response.unfollowUser;
      }

      const variables: FollowUserMutationVariables = { input: { userId } };
      const response = await getHttpClient().request<FollowUserMutationResponse, FollowUserMutationVariables>(
        FOLLOW_USER,
        variables,
      );
      return response.followUser;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['publicProfile', variables.userId] });
      if (currentUserId) void queryClient.invalidateQueries({ queryKey: ['publicProfile', currentUserId] });
      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });
      void queryClient.invalidateQueries({ queryKey: ['searchUsers'] });
      void queryClient.invalidateQueries({ queryKey: ['activityFeed'] });
    },
  });
}

/** Climbs created by a user (across their linked setters), paginated by offset. */
export function useUserClimbs(userId: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['userClimbs', userId],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!userId) throw new Error('Cannot load user climbs without a user id.');
      const variables: GetUserClimbsQueryVariables = {
        input: { userId, limit: SOCIAL_PAGE_SIZE, offset: Number(pageParam) },
      };
      const response = await getHttpClient().request<GetUserClimbsQueryResponse, GetUserClimbsQueryVariables>(
        GET_USER_CLIMBS,
        variables,
      );
      return response.userClimbs;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.climbs.length, 0) : undefined,
    enabled: enabled && !!userId,
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
      // `enabled` gates automatic fetches, but a manual `refetch()` (e.g. pull-to-refresh)
      // bypasses it — short-circuit here so we never send the backend an empty list.
      if (entityIds.length === 0) return [];
      const response = await getHttpClient().request<GetBulkVoteSummariesQueryResponse>(GET_BULK_VOTE_SUMMARIES, {
        input: { entityType, entityIds },
      });
      return response.bulkVoteSummaries;
    },
    enabled: enabled && entityIds.length > 0,
  });
}

/** Accurate vote state for more than one backend-safe batch of entities. */
export function useChunkedBulkVoteSummaries(entityType: SocialEntityType, entityIds: string[], enabled = true) {
  const chunks = chunkEntityIds(dedupeEntityIds(entityIds));
  const results = useQueries({
    queries: chunks.map((chunk) => {
      const sortedIds = [...chunk].sort();
      return {
        queryKey: ['bulkVoteSummaries', entityType, sortedIds],
        queryFn: async () => {
          if (chunk.length === 0) return [];
          const response = await getHttpClient().request<GetBulkVoteSummariesQueryResponse>(GET_BULK_VOTE_SUMMARIES, {
            input: { entityType, entityIds: chunk },
          });
          return response.bulkVoteSummaries;
        },
        enabled: enabled && chunk.length > 0,
      };
    }),
  });

  return results.flatMap((result) => result.data ?? []);
}

/** Accurate vote state for stable groups, such as individual feed pages. */
export function useGroupedBulkVoteSummaries(entityType: SocialEntityType, entityIdGroups: string[][], enabled = true) {
  const chunks = entityIdGroups.flatMap((entityIds) => chunkEntityIds(dedupeEntityIds(entityIds)));
  const results = useQueries({
    queries: chunks.map((chunk) => {
      const sortedIds = [...chunk].sort();
      return {
        queryKey: ['bulkVoteSummaries', entityType, sortedIds],
        queryFn: async () => {
          if (chunk.length === 0) return [];
          const response = await getHttpClient().request<GetBulkVoteSummariesQueryResponse>(GET_BULK_VOTE_SUMMARIES, {
            input: { entityType, entityIds: chunk },
          });
          return response.bulkVoteSummaries;
        },
        enabled: enabled && chunk.length > 0,
      };
    }),
  });

  return results.flatMap((result) => result.data ?? []);
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
      void queryClient.invalidateQueries({ queryKey: ['activityFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
    },
  });
}
