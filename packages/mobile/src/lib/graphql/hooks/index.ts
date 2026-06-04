import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  UserBoard,
  UserBoardConnection,
  Climb,
  ClimbSearchInput,
  Grade,
  Angle,
  MyBoardsInput,
  SearchBoardsInput,
  PopularBoardConfigsInput,
  CreateBoardInput,
  SetterStatsInput,
  UserProfile,
  SessionSummary,
} from '@boardsesh/shared-schema';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsVariables,
  type SimilarClimbsResponse,
  CLIMB_STATS_HISTORY,
  type ClimbStatsHistoryResponse,
} from '@boardsesh/graphql/operations';
import {
  DELETE_DRAFT_CLIMB_MUTATION,
  type DeleteDraftClimbMutationVariables,
  type DeleteDraftClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { getHttpClient } from '../client';
import {
  GET_PROFILE,
  GET_MY_BOARDS,
  GET_BOARD,
  SEARCH_BOARDS,
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_POPULAR_BOARD_CONFIGS,
  CREATE_BOARD,
  GET_GRADES,
  GET_ANGLES,
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_SETTER_STATS,
  GET_CLIMB,
  GET_SESSION_SUMMARY,
  END_SESSION,
  TOGGLE_FAVORITE,
  type GetProfileQueryResponse,
  type GetMyBoardsQueryResponse,
  type GetBoardQueryResponse,
  type SearchBoardsQueryResponse,
  type GetBoardsBySerialNumbersQueryResponse,
  type GetPopularBoardConfigsQueryResponse,
  type CreateBoardMutationResponse,
  type GetGradesQueryResponse,
  type GetAnglesQueryResponse,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetSetterStatsQueryResponse,
  type GetClimbQueryResponse,
  type GetClimbQueryVariables,
  type GetSessionSummaryQueryResponse,
  type GetSessionSummaryQueryVariables,
  type EndSessionMutationVariables,
  type EndSessionMutationResponse,
  type ToggleFavoriteMutationVariables,
  type ToggleFavoriteMutationResponse,
} from '../operations';

// ============================================
// User Profile
// ============================================

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => getHttpClient().request<GetProfileQueryResponse>(GET_PROFILE),
    select: (data) => data.profile,
  });
}

// ============================================
// Board Queries
// ============================================

export function useMyBoards(input?: MyBoardsInput, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['myBoards', input],
    queryFn: () => getHttpClient().request<GetMyBoardsQueryResponse>(GET_MY_BOARDS, { input }),
    select: (data) => data.myBoards,
    enabled: options?.enabled ?? true,
  });
}

export function useBoard(boardUuid: string | null) {
  return useQuery({
    queryKey: ['board', boardUuid],
    queryFn: () => getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, { boardUuid }),
    select: (data) => data.board,
    enabled: !!boardUuid,
  });
}

export function useSearchBoards(input: SearchBoardsInput, enabled = true) {
  return useQuery({
    queryKey: ['searchBoards', input],
    queryFn: () => getHttpClient().request<SearchBoardsQueryResponse>(SEARCH_BOARDS, { input }),
    select: (data) => data.searchBoards,
    enabled,
  });
}

export function useBoardsBySerialNumbers(serialNumbers: string[]) {
  return useQuery({
    queryKey: ['boardsBySerialNumbers', serialNumbers],
    queryFn: () =>
      getHttpClient().request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, { serialNumbers }),
    select: (data) => data.boardsBySerialNumbers,
    enabled: serialNumbers.length > 0,
  });
}

export function usePopularBoardConfigs(input?: PopularBoardConfigsInput, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['popularBoardConfigs', input],
    queryFn: () => getHttpClient().request<GetPopularBoardConfigsQueryResponse>(GET_POPULAR_BOARD_CONFIGS, { input }),
    select: (data) => data.popularBoardConfigs,
    // The popular set is server-cached and changes rarely; avoid refetch churn.
    staleTime: 60 * 60 * 1000,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Boards near a set of coordinates, sorted by distance (the backend computes
 * `distanceMeters` via PostGIS when lat/long are supplied). Stays disabled
 * until coordinates resolve, so callers can pass `null` while awaiting a
 * location permission/fix.
 */
export function useNearbyBoards(coords: { latitude: number; longitude: number } | null, radiusKm = 1) {
  return useQuery({
    queryKey: ['nearbyBoards', coords, radiusKm],
    queryFn: () =>
      getHttpClient().request<SearchBoardsQueryResponse>(SEARCH_BOARDS, {
        input: { latitude: coords?.latitude, longitude: coords?.longitude, radiusKm, limit: 20 },
      }),
    select: (data) => data.searchBoards,
    enabled: coords !== null,
  });
}

export function useCreateBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBoardInput) => {
      const response = await getHttpClient().request<CreateBoardMutationResponse>(CREATE_BOARD, { input });
      return response.createBoard;
    },
    onSuccess: () => {
      // A freshly created board should appear in the user's board list.
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
    },
  });
}

// ============================================
// Board Configuration
// ============================================

export function useGrades(boardName: string, enabled = true) {
  return useQuery({
    queryKey: ['grades', boardName],
    queryFn: () => getHttpClient().request<GetGradesQueryResponse>(GET_GRADES, { boardName }),
    select: (data) => data.grades,
    staleTime: 24 * 60 * 60 * 1000,
    enabled: enabled && boardName.length > 0,
  });
}

export function useAngles(boardName: string, layoutId: number) {
  return useQuery({
    queryKey: ['angles', boardName, layoutId],
    queryFn: () => getHttpClient().request<GetAnglesQueryResponse>(GET_ANGLES, { boardName, layoutId }),
    select: (data) => data.angles,
    staleTime: 24 * 60 * 60 * 1000,
  });
}

// ============================================
// Climb Queries
// ============================================

export function useSearchClimbs(
  input: ClimbSearchInput,
  enabled = true,
  options?: { staleTime?: number; gcTime?: number },
) {
  return useQuery({
    queryKey: ['searchClimbs', input],
    queryFn: () => getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input }),
    select: (data) => data.searchClimbs,
    enabled,
    // undefined → React Query's defaults.
    staleTime: options?.staleTime,
    gcTime: options?.gcTime,
  });
}

export function useSearchClimbsCount(input: ClimbSearchInput, enabled = true) {
  return useQuery({
    queryKey: ['searchClimbsCount', input],
    queryFn: () => getHttpClient().request<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input }),
    select: (data) => data.searchClimbs.totalCount,
    enabled,
    // Hold the last count while a new filter set is in flight so the bar /
    // "Show N" button doesn't flicker to blank on every filter change.
    placeholderData: (previous) => previous,
  });
}

export function useSetterStats(input: SetterStatsInput, enabled = true) {
  return useQuery({
    queryKey: ['setterStats', input],
    queryFn: () => getHttpClient().request<GetSetterStatsQueryResponse>(GET_SETTER_STATS, { input }),
    select: (data) => data.setterStats,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useClimb(variables: GetClimbQueryVariables | null) {
  return useQuery({
    queryKey: ['climb', variables],
    queryFn: () => getHttpClient().request<GetClimbQueryResponse>(GET_CLIMB, variables!),
    select: (data) => data.climb,
    enabled: !!variables,
  });
}

/**
 * Delete a draft climb. The backend only permits deleting climbs that are
 * still drafts and owned by the caller. Busts the climb-search caches so the
 * deleted draft disappears from the drafts list (and any climb list) without a
 * manual reload.
 */
export function useDeleteDraftClimb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: DeleteDraftClimbMutationVariables) => {
      const response = await getHttpClient().request<DeleteDraftClimbMutationResponse>(
        DELETE_DRAFT_CLIMB_MUTATION,
        variables,
      );
      return response.deleteDraftClimb;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbsCount'] });
    },
  });
}

// ============================================
// Session Queries
// ============================================

export function useSessionSummary(sessionId: string | null) {
  return useQuery({
    queryKey: ['sessionSummary', sessionId],
    queryFn: () =>
      getHttpClient().request<GetSessionSummaryQueryResponse>(GET_SESSION_SUMMARY, {
        sessionId,
      } as GetSessionSummaryQueryVariables),
    select: (data) => data.sessionSummary,
    enabled: !!sessionId,
  });
}

export function useEndSession() {
  return useMutation({
    mutationFn: async (variables: EndSessionMutationVariables) => {
      const response = await getHttpClient().request<EndSessionMutationResponse>(END_SESSION, variables);
      return response.endSession;
    },
  });
}

// ============================================
// Mutations
// ============================================

export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: ToggleFavoriteMutationVariables) =>
      getHttpClient().request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, variables),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
    },
  });
}

// `useSaveTick` moved to `@boardsesh/board-react` — call sites import the
// shared hook (with optimistic updates + stats invalidations) directly.

// ============================================
// Beta Videos (Instagram + TikTok per climb)
// ============================================

import {
  GET_BETA_LINKS,
  ATTACH_BETA_LINK,
  type GetBetaLinksQueryResponse,
  type GetBetaLinksQueryVariables,
  type AttachBetaLinkMutationVariables,
  type AttachBetaLinkMutationResponse,
} from '@boardsesh/graphql/operations/beta-links';
import { dedupeBetaLinks } from '@boardsesh/shared-schema';
import { mapBetaLinks } from '../../beta-video-url';

export function useBetaLinks(boardType: string, climbUuid: string, enabled = true) {
  return useQuery({
    queryKey: ['betaLinks', boardType, climbUuid],
    queryFn: () =>
      getHttpClient().request<GetBetaLinksQueryResponse, GetBetaLinksQueryVariables>(GET_BETA_LINKS, {
        boardType,
        climbUuid,
      }),
    select: (data) => dedupeBetaLinks(mapBetaLinks(data.betaLinks)),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

// ============================================
// Similar Climbs + Community stats (play drawer)
// ============================================

/**
 * Position-only Jaccard similar climbs for a saved climb. `climbUuid` null
 * disables the query (e.g. before a climb is selected).
 */
export function useSimilarClimbs(
  boardName: string,
  climbUuid: string | null,
  layoutId: number,
  angle: number,
  limit = 12,
) {
  return useQuery({
    queryKey: ['similarClimbs', boardName, climbUuid, layoutId, angle, limit],
    queryFn: () => {
      const variables: SimilarClimbsVariables = {
        input: { boardType: boardName, layoutId, climbUuid: climbUuid!, angle, limit },
      };
      return getHttpClient().request<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, variables);
    },
    select: (data) => data.similarClimbs,
    enabled: !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Last-12-months stats snapshots for a climb, one row per (angle, snapshot).
 * Powers the Community "grade by angle" histogram.
 */
export function useClimbStatsHistory(boardName: string, climbUuid: string | null) {
  return useQuery({
    queryKey: ['climbStatsHistory', boardName, climbUuid],
    queryFn: () =>
      getHttpClient().request<ClimbStatsHistoryResponse>(CLIMB_STATS_HISTORY, {
        boardName,
        climbUuid: climbUuid!,
      }),
    select: (data) => data.climbStatsHistory,
    enabled: !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAttachBetaLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AttachBetaLinkMutationVariables['input']) =>
      getHttpClient().request<AttachBetaLinkMutationResponse, AttachBetaLinkMutationVariables>(ATTACH_BETA_LINK, {
        input,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['betaLinks', vars.boardType, vars.climbUuid] });
    },
  });
}

// Re-export feature-specific hooks that live alongside this barrel so the
// import surface from this directory stays a single path.
export { useMobileClimbActionsData } from './use-mobile-climb-actions-data';
export {
  useAllBoardsTicks,
  useUserProfileStats,
  useUserClimbPercentile,
  useUserAscentsFeed,
  useSessionGroupedFeed,
} from './use-you-data';
export { useYouProfileData } from './use-you-profile-data';
export { useVote, useBulkVoteSummaries, useComments, useAddComment } from './use-social';
export { useSessionDetail, useUpdateInferredSession, useSessionPreview } from './use-session-detail';
