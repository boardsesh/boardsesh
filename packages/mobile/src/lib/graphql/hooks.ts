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
  SetterStatsInput,
  UserProfile,
  SessionSummary,
} from '@boardsesh/shared-schema';
import { getHttpClient } from './client';
import {
  GET_PROFILE,
  GET_MY_BOARDS,
  GET_DEFAULT_BOARD,
  GET_BOARD,
  SEARCH_BOARDS,
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_GRADES,
  GET_ANGLES,
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_SETTER_STATS,
  GET_CLIMB,
  GET_SESSION_SUMMARY,
  END_SESSION,
  TOGGLE_FAVORITE,
  SAVE_TICK,
  type GetProfileQueryResponse,
  type GetMyBoardsQueryResponse,
  type GetDefaultBoardQueryResponse,
  type GetBoardQueryResponse,
  type SearchBoardsQueryResponse,
  type GetBoardsBySerialNumbersQueryResponse,
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
} from './operations';

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

export function useDefaultBoard() {
  return useQuery({
    queryKey: ['defaultBoard'],
    queryFn: () => getHttpClient().request<GetDefaultBoardQueryResponse>(GET_DEFAULT_BOARD),
    select: (data) => data.defaultBoard,
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

export function useSearchClimbs(input: ClimbSearchInput, enabled = true) {
  return useQuery({
    queryKey: ['searchClimbs', input],
    queryFn: () => getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input }),
    select: (data) => data.searchClimbs,
    enabled,
  });
}

export function useSearchClimbsCount(input: ClimbSearchInput, enabled = true) {
  return useQuery({
    queryKey: ['searchClimbsCount', input],
    queryFn: () => getHttpClient().request<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input }),
    select: (data) => data.searchClimbs.totalCount,
    enabled,
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
import { mapBetaLinks } from '../beta-video-url';

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
