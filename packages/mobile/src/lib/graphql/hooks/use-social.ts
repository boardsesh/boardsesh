import { useMemo } from 'react';
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
import { batchVoteSummaryEntityIds, type SocialEntityType } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

const SOCIAL_PAGE_SIZE = 30;

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

type BulkVoteSummaries = GetBulkVoteSummariesQueryResponse['bulkVoteSummaries'];

type BulkVoteSummaryChunkResult = {
  data: BulkVoteSummaries | undefined;
  refetch: () => Promise<unknown>;
};

/** One ≤100-ID request, cached and retried independently of its siblings. */
function bulkVoteSummaryChunkQuery(entityType: SocialEntityType, chunk: string[], enabled: boolean) {
  return {
    // Sorted so two callers holding the same IDs in different orders share a
    // cache entry (the request itself keeps the caller's order).
    queryKey: ['bulkVoteSummaries', entityType, [...chunk].sort()],
    queryFn: async (): Promise<BulkVoteSummaries> => {
      const response = await getHttpClient().request<GetBulkVoteSummariesQueryResponse>(GET_BULK_VOTE_SUMMARIES, {
        input: { entityType, entityIds: chunk },
      });
      return response.bulkVoteSummaries;
    },
    enabled,
  };
}

/**
 * Merges the per-chunk results into one summary list plus the chunks' own
 * `refetch` handles.
 *
 * Passing this to `useQueries` as `combine` is what keeps the merged value
 * referentially stable. Without a `combine`, `useQueries` hands back a
 * freshly mapped array on every render, so `.data` would change identity even
 * when no vote moved — which churns the Home feed's `summaryMap` and, through
 * FlashList `extraData`, re-invokes `renderItem` for every mounted row on any
 * unrelated parent render. With `combine`, react-query runs the merge through
 * `replaceEqualDeep` and hands back the previous value when nothing changed.
 *
 * Declared at module scope so its identity never changes: react-query re-runs
 * `combine` whenever the function itself does.
 */
function combineVoteSummaryChunks(results: BulkVoteSummaryChunkResult[]) {
  return {
    summaries: results.flatMap((result) => result.data ?? []),
    // Each `refetch` is bound to its chunk's observer and so is stable across
    // renders, which lets `replaceEqualDeep` keep this array's identity too.
    refetchChunks: results.map((result) => result.refetch),
  };
}

/**
 * Shared chunked-query construction for the bulk-vote-summary hooks — one
 * query per ≤100-ID chunk, merged back into a single stable list.
 */
function useBulkVoteSummaryChunks(entityType: SocialEntityType, chunks: string[][], enabled: boolean) {
  return useQueries({
    queries: chunks.map((chunk) => bulkVoteSummaryChunkQuery(entityType, chunk, enabled)),
    combine: combineVoteSummaryChunks,
  });
}

/**
 * Splits an ID list into ≤100-ID chunks, once per list change rather than per
 * render. Memoized on the array reference, so a caller that builds its list
 * inline (`ticks.map((tick) => tick.uuid)`) re-chunks every render — harmless,
 * since `useQueries` matches its observers by query hash either way, and the
 * feed screens that hand over the long lists already memoize them.
 */
function useVoteSummaryChunks(entityIds: string[]): string[][] {
  return useMemo(() => batchVoteSummaryEntityIds(entityIds), [entityIds]);
}

/**
 * Accurate vote state (count + `userVote`) for a batch of entities. Chunks
 * internally so callers never need to worry about the backend's 100-ID cap
 * (`BulkVoteSummaryInputSchema`) — a caller handing this an unbounded,
 * paginating list (e.g. a feed) used to blow the cap outright once it passed
 * 100 rows, failing the whole query. A failed chunk contributes no rows
 * rather than blanking the ones that did load. `refetch` re-runs every
 * chunk (e.g. for pull-to-refresh).
 *
 * Returns `{ data, refetch }` rather than a `UseQueryResult` — there is no
 * single query behind it to report `isLoading`/`isError` for. A caller that
 * needs per-chunk state should use `useQueries` directly.
 */
export function useBulkVoteSummaries(entityType: SocialEntityType, entityIds: string[], enabled = true) {
  const chunks = useVoteSummaryChunks(entityIds);
  const { summaries, refetchChunks } = useBulkVoteSummaryChunks(entityType, chunks, enabled);

  // Callers keep this object in `useCallback`/`useMemo` deps (Home's
  // pull-to-refresh handler does), so it only changes when the vote data or
  // the chunk set actually does.
  return useMemo(
    () => ({
      data: summaries,
      refetch: () => Promise.all(refetchChunks.map((refetchChunk) => refetchChunk())),
    }),
    [summaries, refetchChunks],
  );
}

/** Accurate vote state for more than one backend-safe batch of entities. */
export function useChunkedBulkVoteSummaries(entityType: SocialEntityType, entityIds: string[], enabled = true) {
  const chunks = useVoteSummaryChunks(entityIds);
  return useBulkVoteSummaryChunks(entityType, chunks, enabled).summaries;
}

/** Accurate vote state for stable groups, such as individual feed pages. */
export function useGroupedBulkVoteSummaries(entityType: SocialEntityType, entityIdGroups: string[][], enabled = true) {
  const chunks = useMemo(
    () => entityIdGroups.flatMap((entityIds) => batchVoteSummaryEntityIds(entityIds)),
    [entityIdGroups],
  );
  return useBulkVoteSummaryChunks(entityType, chunks, enabled).summaries;
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
