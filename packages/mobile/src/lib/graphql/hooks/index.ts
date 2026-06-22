import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  BoardName,
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
  UpdateBoardInput,
  SetterStatsInput,
  UserProfile,
  PublicUserProfile,
  UpdateProfileInput,
  SessionSummary,
  SessionHealthExport,
} from '@boardsesh/shared-schema';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsVariables,
  type SimilarClimbsResponse,
  CLIMB_STATS_HISTORY,
  type ClimbStatsHistoryResponse,
  CLIMB_STATS_FOR_ANGLES,
  type ClimbStatsForAnglesResponse,
} from '@boardsesh/graphql/operations';
import {
  GET_FAVORITES,
  type FavoritesQueryVariables,
  type FavoritesQueryResponse,
} from '@boardsesh/graphql/operations/favorites';
import {
  DELETE_DRAFT_CLIMB_MUTATION,
  type DeleteDraftClimbMutationVariables,
  type DeleteDraftClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { SEARCH_GYMS, type SearchGymsQueryResponse } from '@boardsesh/graphql/operations/gyms';
import {
  UPDATE_BOARD,
  DELETE_BOARD,
  UNFOLLOW_BOARD,
  GET_BOARD_BY_SLUG,
  type UpdateBoardMutationResponse,
  type DeleteBoardMutationResponse,
  type UnfollowBoardMutationResponse,
  type GetBoardBySlugQueryResponse,
} from '@boardsesh/graphql/operations/boards';
import { getHttpClient } from '../client';
import {
  GET_PROFILE,
  UPDATE_PROFILE,
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
  GET_SESSION_HEALTH_EXPORT,
  END_SESSION,
  TOGGLE_FAVORITE,
  type GetProfileQueryResponse,
  type UpdateProfileMutationResponse,
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
  type GetSessionHealthExportQueryResponse,
  type GetSessionHealthExportQueryVariables,
  type EndSessionMutationVariables,
  type EndSessionMutationResponse,
  type ToggleFavoriteMutationVariables,
  type ToggleFavoriteMutationResponse,
} from '../operations';

// ============================================
// User Profile
// ============================================

export function useProfile(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => getHttpClient().request<GetProfileQueryResponse>(GET_PROFILE),
    select: (data) => data.profile,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Update the current user's display name and/or avatar URL. The mutation result
 * is written into the `['profile']` cache immediately, then invalidated so every
 * current-user consumer refreshes against the backend. The avatar image itself
 * is uploaded separately via `uploadAvatar` (REST), and its absolute URL is then
 * persisted here.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProfileInput) => {
      const response = await getHttpClient().request<UpdateProfileMutationResponse>(UPDATE_PROFILE, { input });
      return response.updateProfile;
    },
    onSuccess: (updatedProfile) => {
      queryClient.setQueryData<GetProfileQueryResponse>(['profile'], { profile: updatedProfile });
      queryClient.setQueryData<PublicUserProfile | null>(['publicProfile', updatedProfile.id], (cachedProfile) =>
        cachedProfile
          ? {
              ...cachedProfile,
              displayName: updatedProfile.displayName,
              avatarUrl: updatedProfile.avatarUrl,
            }
          : cachedProfile,
      );
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
      void queryClient.invalidateQueries({ queryKey: ['publicProfile', updatedProfile.id] });
    },
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

/**
 * Resolve a named board by its URL slug (the `/b/{slug}` board-entity routes).
 * Returns the full shared board entity including its stored angle — used to turn
 * a session whose `boardPath` is a named-board shape into a usable board. The
 * non-hook {@link fetchBoardBySlug} backs the same lookup at join time, where a
 * hook can't run.
 */
export function fetchBoardBySlug(slug: string): Promise<UserBoard | null> {
  return getHttpClient()
    .request<GetBoardBySlugQueryResponse>(GET_BOARD_BY_SLUG, { slug })
    .then((data) => data.boardBySlug);
}

export function useBoardBySlug(slug: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['boardBySlug', slug],
    queryFn: () => getHttpClient().request<GetBoardBySlugQueryResponse>(GET_BOARD_BY_SLUG, { slug }),
    select: (data) => data.boardBySlug,
    enabled: (options?.enabled ?? true) && !!slug,
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
export function useNearbyBoards(
  coords: { latitude: number; longitude: number } | null,
  radiusKm = 1,
  query?: string,
  // Backend caps this at 50. The gym finder needs the higher ceiling so a dense
  // metro's gym-attached + standalone boards don't share a 20-row budget (which
  // would falsely show "no boards" for a gym whose boards fell outside the top
  // 20). The "Near you" carousel keeps the small default.
  limit = 20,
  // Filter to these board types (OR). Empty/undefined means no board-type filter.
  boardTypes?: BoardName[],
) {
  // Empty string means "no name filter" to the resolver; normalise to undefined
  // so the cache key and the request payload stay clean.
  const nameFilter = query && query.trim().length > 0 ? query.trim() : undefined;
  const typeFilter = boardTypes && boardTypes.length > 0 ? boardTypes : undefined;
  return useQuery({
    queryKey: ['nearbyBoards', coords, radiusKm, nameFilter, limit, typeFilter ?? null],
    queryFn: () =>
      getHttpClient().request<SearchBoardsQueryResponse>(SEARCH_BOARDS, {
        input: {
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          radiusKm,
          limit,
          query: nameFilter,
          boardTypes: typeFilter,
        },
      }),
    select: (data) => data.searchBoards,
    enabled: coords !== null,
    // Keep the previous boards visible while a new center/filter loads so the
    // gym-finder map doesn't blank its pins/list on every pan (the queryKey
    // changes when `coords` moves). Harmless for the "Near you" carousel, whose
    // key rarely changes.
    placeholderData: keepPreviousData,
  });
}

export function useNearbyGyms(
  coords: { latitude: number; longitude: number } | null,
  radiusKm = 50,
  query?: string,
  // Filter to gyms that have a board of one of these types (OR).
  boardTypes?: BoardName[],
) {
  const nameFilter = query && query.trim().length > 0 ? query.trim() : undefined;
  const typeFilter = boardTypes && boardTypes.length > 0 ? boardTypes : undefined;
  return useQuery({
    queryKey: ['nearbyGyms', coords, radiusKm, nameFilter, typeFilter ?? null],
    queryFn: () =>
      getHttpClient().request<SearchGymsQueryResponse>(SEARCH_GYMS, {
        input: {
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          radiusKm,
          limit: 50,
          query: nameFilter,
          boardTypes: typeFilter,
        },
      }),
    select: (data) => data.searchGyms,
    enabled: coords !== null,
    // See useNearbyBoards: keep prior gyms on screen while a panned center
    // refetches so markers/list don't flicker.
    placeholderData: keepPreviousData,
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

/**
 * Edit a board the user owns (name, visibility, angle, location, serial — and
 * layout/size/sets only when the board has zero ticks; the server enforces the
 * latter). Invalidate-only: `myBoards` carries enriched fields (counts, sizeName)
 * that can't be rebuilt client-side. Re-syncing the active board's denormalised
 * AsyncStorage copy is the edit screen's job — see `useSetActiveBoard`.
 */
export function useUpdateBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateBoardInput) => {
      const response = await getHttpClient().request<UpdateBoardMutationResponse>(UPDATE_BOARD, { input });
      return response.updateBoard;
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['board', updated.uuid] });
    },
  });
}

/**
 * Soft-delete a board the user owns. `deleteBoard` takes a BARE `boardUuid`
 * (unlike `unfollowBoard`, which wraps it in `{ input }`). Clearing the active
 * board when the deleted one was active is the screen's responsibility.
 */
export function useDeleteBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (boardUuid: string) => {
      const response = await getHttpClient().request<DeleteBoardMutationResponse>(DELETE_BOARD, { boardUuid });
      return response.deleteBoard;
    },
    onSuccess: (_deleted, boardUuid) => {
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['board', boardUuid] });
    },
  });
}

/**
 * Stop following someone else's board. `unfollowBoard` wraps the uuid in
 * `{ input: { boardUuid } }` (a FollowBoardInput) — NOT the bare arg shape that
 * `deleteBoard` uses. Reversible, so callers skip the confirm dialog.
 */
export function useUnfollowBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (boardUuid: string) => {
      const response = await getHttpClient().request<UnfollowBoardMutationResponse>(UNFOLLOW_BOARD, {
        input: { boardUuid },
      });
      return response.unfollowBoard;
    },
    onSuccess: () => {
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

export function useSessionHealthExport(sessionId: string | null) {
  return useQuery<SessionHealthExport | null>({
    queryKey: ['sessionHealthExport', sessionId],
    queryFn: async () => {
      const response = await getHttpClient().request<
        GetSessionHealthExportQueryResponse,
        GetSessionHealthExportQueryVariables
      >(GET_SESSION_HEALTH_EXPORT, {
        sessionId: sessionId!,
      });
      return response.sessionHealthExport;
    },
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
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      // Bust the per-climb favorite-status cache so a re-open reflects the new
      // state from the server, not a stale 5-min-cached value.
      void queryClient.invalidateQueries({
        queryKey: ['favoriteStatus', variables.input.boardName, variables.input.climbUuid, variables.input.angle],
      });
    },
  });
}

/**
 * Server-side favorite status for a single climb at the given angle. The
 * favorite key is (userId, boardName, climbUuid, angle) on the backend, so the
 * angle matters — favoriting at 40° is distinct from 25°. Disabled until a
 * `climbUuid` is supplied (and via `enabled`, so callers can gate it on a sheet
 * being open). Returns `true` when the climb is favorited at this angle.
 */
export function useFavoriteStatus(
  boardName: string,
  climbUuid: string | null,
  angle: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['favoriteStatus', boardName, climbUuid, angle],
    queryFn: () =>
      getHttpClient().request<FavoritesQueryResponse, FavoritesQueryVariables>(GET_FAVORITES, {
        boardName,
        climbUuids: [climbUuid!],
        angle,
      }),
    select: (data) => data.favorites.includes(climbUuid!),
    enabled: (options?.enabled ?? true) && !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
}

// `useSaveTick` moved to `@boardsesh/board-react` — call sites import the
// shared hook (with optimistic updates + stats invalidations) directly.

// ============================================
// Beta Videos (Instagram + TikTok per climb)
// ============================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GET_BETA_LINKS,
  GET_RECENT_BETA_LINKS,
  GET_USER_BETA_LINKS,
  ATTACH_BETA_LINK,
  type GetBetaLinksQueryResponse,
  type GetBetaLinksQueryVariables,
  type GetRecentBetaLinksQueryResponse,
  type GetRecentBetaLinksQueryVariables,
  type GetUserBetaLinksQueryResponse,
  type GetUserBetaLinksQueryVariables,
  type RecentBetaLinkGqlRow,
  type AttachBetaLinkMutationVariables,
  type AttachBetaLinkMutationResponse,
} from '@boardsesh/graphql/operations/beta-links';
import { betaLinkIdentity, dedupeBetaLinks, isBetaVideoUrl, type BetaLink } from '@boardsesh/shared-schema';
import { mapBetaLink, mapBetaLinks } from '../../beta-video-url';

export type RecentBetaVideo = Omit<RecentBetaLinkGqlRow, 'betaLink'> & {
  betaLink: BetaLink;
};

/**
 * Narrow recent beta-link rows to the shelf the client actually shows:
 * scoped to the selected layout, video-only, deduped by stable video
 * identity, and capped at `limit`. A null `layoutId` means "any layout".
 * Exported for tests; production callers go through `useRecentBetaLinks`.
 */
export function selectRecentBetaVideos(
  rows: RecentBetaLinkGqlRow[],
  layoutId: number | null | undefined,
  limit: number,
): RecentBetaVideo[] {
  const seenIdentities = new Set<string>();
  const videos: RecentBetaVideo[] = [];

  for (const row of rows) {
    // Beta is board-specific: a Kilter Original beta is useless on a Kilter
    // Homewall, so scope to the selected board's layout too, not just type.
    if (layoutId != null && row.layoutId !== layoutId) continue;
    const betaLink = mapBetaLink(row.betaLink);
    if (!isBetaVideoUrl(betaLink.link)) continue;
    const identity = betaLinkIdentity(betaLink.link);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    videos.push({ ...row, betaLink });
    if (videos.length >= limit) break;
  }

  return videos;
}

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

export function useRecentBetaLinks(limit = 20, boardType?: string | null, layoutId?: number | null, enabled = true) {
  return useQuery({
    queryKey: ['recentBetaLinks', limit, boardType ?? null, layoutId ?? null],
    queryFn: () =>
      getHttpClient().request<GetRecentBetaLinksQueryResponse, GetRecentBetaLinksQueryVariables>(
        GET_RECENT_BETA_LINKS,
        {
          // Over-fetch when a layout is set so the client-side layout filter
          // below still fills the shelf (the server query only narrows by board
          // type). A backend `layoutId` arg would let us drop this.
          limit: layoutId != null ? limit * 4 : limit,
          boardType,
        },
      ),
    select: (data) => selectRecentBetaVideos(data.recentBetaLinks, layoutId, limit),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

const USER_BETA_LINKS_PAGE_SIZE = 20;

export type UseUserBetaLinksResult = {
  /** Accumulated, deduped, video-only beta links across all loaded pages. */
  videos: RecentBetaVideo[];
  /** True while the first page is loading. */
  isLoading: boolean;
  /** True while a subsequent page is loading. */
  isLoadingMore: boolean;
  /** Whether the last page came back full (so there may be more). */
  hasMore: boolean;
  /** True when the first-page fetch failed. */
  hasError: boolean;
  loadMore: () => void;
  refetch: () => void;
};

/**
 * A climber's recent beta videos, offset-paginated for the profile shelf and
 * its "See all" grid. Public query (no auth token). Mirrors the offset-paging
 * shape of `useUserPlaylists`: page 0 on mount/userId-change, more pages on
 * `loadMore`, dedupe + video-only filter persisted across pages.
 */
export function useUserBetaLinks(
  userId: string | null | undefined,
  pageSize: number = USER_BETA_LINKS_PAGE_SIZE,
  enabled = true,
): UseUserBetaLinksResult {
  const [videos, setVideos] = useState<RecentBetaVideo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [hasError, setHasError] = useState(false);

  const seenIdentitiesRef = useRef<Set<string>>(new Set());
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const isFetchingRef = useRef(false);
  // Bumped on every reset (userId change) and refetch. A response whose
  // generation no longer matches is discarded, so a request still in flight
  // when the user navigates to another climber can't write the previous
  // climber's beta into the now-reset state (and can't free the fetch flag the
  // new request owns).
  const generationRef = useRef(0);

  const active = enabled && !!userId;

  const fetchPage = useCallback(
    async (offset: number, isInitial: boolean, generation: number) => {
      if (!userId) return;
      isFetchingRef.current = true;
      if (isInitial) setIsLoading(true);
      else setIsLoadingMore(true);

      try {
        const response = await getHttpClient().request<GetUserBetaLinksQueryResponse, GetUserBetaLinksQueryVariables>(
          GET_USER_BETA_LINKS,
          { userId, limit: pageSize, offset },
        );
        // A newer reset/refetch superseded this request while it was in flight.
        if (generation !== generationRef.current) return;

        const rows = response.userBetaLinks;
        const fresh: RecentBetaVideo[] = [];
        for (const betaRow of rows) {
          const betaLink = mapBetaLink(betaRow.betaLink);
          if (!isBetaVideoUrl(betaLink.link)) continue;
          const identity = betaLinkIdentity(betaLink.link);
          if (seenIdentitiesRef.current.has(identity)) continue;
          seenIdentitiesRef.current.add(identity);
          fresh.push({ ...betaRow, betaLink });
        }

        setVideos((prev) => (isInitial ? fresh : [...prev, ...fresh]));
        // Advance the DB offset by the requested page size — it must skip the
        // rows already fetched regardless of how many survived the video-only /
        // dedupe filter above. `hasMore` is a heuristic: a full raw page back
        // means there may be more.
        offsetRef.current = offset + pageSize;
        const more = rows.length === pageSize;
        setHasMore(more);
        hasMoreRef.current = more;
        setHasError(false);
      } catch (err: unknown) {
        if (generation !== generationRef.current) return;
        console.error('Failed to fetch user beta links:', err);
        if (isInitial) setHasError(true);
      } finally {
        // Only the current generation owns the shared loading/fetching flags; a
        // superseded request must not clear them out from under the new one.
        if (generation === generationRef.current) {
          if (isInitial) setIsLoading(false);
          else setIsLoadingMore(false);
          isFetchingRef.current = false;
        }
      }
    },
    [userId, pageSize],
  );

  // Reset every page-state ref + flag under a fresh generation and re-fetch page
  // 0. Shared by the userId-change effect and the manual refetch so both
  // supersede any in-flight request rather than being blocked by it (clearing
  // isFetchingRef) and clear the error overlay before retrying (setHasError).
  const startFresh = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    seenIdentitiesRef.current = new Set();
    offsetRef.current = 0;
    hasMoreRef.current = false;
    isFetchingRef.current = false;
    setVideos([]);
    setHasMore(false);
    setHasError(false);
    if (!active) {
      setIsLoading(false);
      return;
    }
    void fetchPage(0, true, generation);
  }, [active, fetchPage]);

  useEffect(() => {
    startFresh();
  }, [startFresh]);

  const loadMore = useCallback(() => {
    if (hasMoreRef.current && !isFetchingRef.current) {
      void fetchPage(offsetRef.current, false, generationRef.current);
    }
  }, [fetchPage]);

  return { videos, isLoading, isLoadingMore, hasMore, hasError, loadMore, refetch: startFresh };
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

/**
 * Latest per-angle stats for a climb, carrying the per-source ascensionist
 * counts (kilter / aurora / boardsesh) the Community "grade by angle" chart
 * needs to redraw bar heights when the user switches ascent source. Unlike
 * {@link useClimbStatsHistory} (multi-snapshot, for the angle selector), this
 * returns one row per angle.
 */
export function useClimbStatsForAngles(boardName: string, climbUuid: string | null) {
  return useQuery({
    queryKey: ['climbStatsForAngles', boardName, climbUuid],
    queryFn: () =>
      getHttpClient().request<ClimbStatsForAnglesResponse>(CLIMB_STATS_FOR_ANGLES, {
        boardName,
        climbUuid: climbUuid!,
      }),
    select: (data) => data.climbStatsForAngles,
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
      void queryClient.invalidateQueries({ queryKey: ['betaLinks', vars.boardType, vars.climbUuid] });
      void queryClient.invalidateQueries({ queryKey: ['recentBetaLinks'] });
    },
  });
}

// Re-export feature-specific hooks that live alongside this barrel so the
// import surface from this directory stays a single path.
export { useInfiniteSearchClimbs } from './use-infinite-search-climbs';
export { useBetaLinkPreview } from './use-beta-link-preview';
export { useMobileClimbActionsData } from './use-mobile-climb-actions-data';
export {
  useAllBoardsTicks,
  useUserProfileStats,
  useUserClimbPercentile,
  useUserAscentsFeed,
  useAscentCaptionMatches,
  useActivityFeed,
  useSessionGroupedFeed,
} from './use-you-data';
export { useYouProfileData } from './use-you-profile-data';
export {
  usePublicProfile,
  useFollowers,
  useFollowing,
  useSearchUsers,
  useToggleUserFollow,
  useUserClimbs,
  useVote,
  useBulkVoteSummaries,
  useChunkedBulkVoteSummaries,
  useGroupedBulkVoteSummaries,
  useComments,
  useAddComment,
} from './use-social';
export { useSessionDetail, useSessionPreview } from './use-session-detail';
export { useDeleteAccountInfo, useDeleteAccount } from './use-delete-account';
export {
  useIntegrationStatuses,
  useDisconnectIntegration,
  useSetIntegrationAutoSync,
  useSyncSessionToIntegration,
} from './use-integrations';
