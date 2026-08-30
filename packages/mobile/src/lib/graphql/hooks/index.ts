import { useQuery, useMutation, useQueryClient, keepPreviousData, onlineManager } from '@tanstack/react-query';
import type {
  BoardName,
  UserBoard,
  ClimbSearchInput,
  Grade,
  MyBoardsInput,
  SearchBoardsInput,
  PopularBoardConfigsInput,
  CreateBoardInput,
  UpdateBoardInput,
  SetterStatsInput,
  PublicUserProfile,
  UpdateProfileInput,
  SessionHealthExport,
  UpdateGymInput,
  GrantGymWriteAccessInput,
  RevokeGymWriteAccessInput,
  RequestGymClaimInput,
} from '@boardsesh/shared-schema';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsVariables,
  type SimilarClimbsResponse,
  CLIMB_STATS_HISTORY,
  type ClimbStatsHistoryResponse,
  BOARDSESH_GRADE,
  type BoardseshGradeResponse,
  BOARDSESH_GRADES_FOR_ANGLES,
  type BoardseshGradesForAnglesResponse,
  UPDATE_SESSION,
  type UpdateSessionVariables,
  type UpdateSessionResponse,
} from '@boardsesh/graphql/operations';
import {
  GET_FAVORITES,
  type FavoritesQueryVariables,
  type FavoritesQueryResponse,
} from '@boardsesh/graphql/operations/favorites';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { useBoardAdapter } from '@boardsesh/board-react';
import { myBoardsQueryKey } from '../query-keys';
import { getDatabaseHandle } from '../../../db';
import { offlineAwareRequest } from '../offline-request';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';
import { addFavoriteLocal, removeFavoriteLocal } from '../../../hooks/use-offline-mutations';
import type { GraphQLFetch } from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../../../offline/offline-sync-adapter';
import {
  DELETE_DRAFT_CLIMB_MUTATION,
  type DeleteDraftClimbMutationVariables,
  type DeleteDraftClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import {
  SEARCH_GYMS,
  GET_GYM,
  GET_MY_GYMS,
  UPDATE_GYM,
  GET_GYM_MEMBERS,
  GRANT_GYM_WRITE_ACCESS,
  REVOKE_GYM_WRITE_ACCESS,
  REQUEST_GYM_CLAIM,
  LINK_BOARD_TO_GYM,
  type SearchGymsQueryResponse,
  type GetGymQueryResponse,
  type GetMyGymsQueryResponse,
  type UpdateGymMutationResponse,
  type LinkBoardToGymMutationResponse,
  type GetGymMembersQueryResponse,
  type GrantGymWriteAccessMutationResponse,
  type RevokeGymWriteAccessMutationResponse,
  type RequestGymClaimMutationResponse,
} from '@boardsesh/graphql/operations/gyms';
import {
  UPDATE_BOARD,
  DELETE_BOARD,
  FOLLOW_BOARD,
  UNFOLLOW_BOARD,
  GET_BOARD_BY_SLUG,
  type UpdateBoardMutationResponse,
  type DeleteBoardMutationResponse,
  type FollowBoardMutationResponse,
  type UnfollowBoardMutationResponse,
  type GetBoardBySlugQueryResponse,
} from '@boardsesh/graphql/operations/boards';
import { getHttpClient } from '../client';
import {
  matchesAdvertisedType,
  sharedAdvertisedBoardType,
  type AdvertisedBoardTypes,
} from '../../ble/advertised-board-type';
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
  GET_SETTER_STATS,
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_CLIMB,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetClimbQueryResponse,
  GET_SESSION_SUMMARY,
  GET_SESSION_HEALTH_EXPORT,
  GET_OTA_PREVIEW_CHANNELS,
  END_SESSION,
  TOGGLE_FAVORITE,
  type GetProfileQueryResponse,
  type GetOtaPreviewChannelsQueryResponse,
  type UpdateProfileMutationResponse,
  type GetMyBoardsQueryResponse,
  type GetBoardQueryResponse,
  type SearchBoardsQueryResponse,
  type GetBoardsBySerialNumbersQueryResponse,
  type GetPopularBoardConfigsQueryResponse,
  type CreateBoardMutationResponse,
  type GetGradesQueryResponse,
  type GetAnglesQueryResponse,
  type GetSetterStatsQueryResponse,
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

type ToggleFavoriteVariables = ToggleFavoriteMutationVariables & {
  currentlyFavorited?: boolean;
};

function graphqlFetchFromClient(): GraphQLFetch {
  return (query, variables) => getHttpClient().request(query, variables);
}

function scheduleDrain(
  db: NonNullable<ReturnType<typeof getDatabaseHandle>>,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void drainMutationQueue(db, queryClient, graphqlFetchFromClient()).catch((error: unknown) => {
    if (__DEV__) {
      console.warn('[MutationQueue] drain failed after local write:', error);
    }
  });
}

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

// ============================================
// OTA Preview Channels
// ============================================

/**
 * Live per-PR OTA preview channels (`pr-<number>`) with their PR titles, for the
 * in-app channel switcher. Public — no auth. The backend caches and fail-soft
 * returns [] on any GitHub error, so this never throws on the data path; the
 * screen renders an empty state instead.
 */
export function useOtaPreviewChannels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['otaPreviewChannels'],
    queryFn: () => getHttpClient().request<GetOtaPreviewChannelsQueryResponse>(GET_OTA_PREVIEW_CHANNELS),
    select: (data) => data.otaPreviewChannels,
    staleTime: 60_000,
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

// The key lives in `../query-keys` because `useCrossBoardAddGate` reads this
// roster imperatively out of the cache; both sides import the one helper so the
// shape can't drift apart. Re-exported here for callers already on this barrel.
export { myBoardsQueryKey };

export function useMyBoards(input?: MyBoardsInput, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: myBoardsQueryKey(input),
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
 * One board by uuid, fetched imperatively. For the moments a board is identified
 * mid-interaction rather than at render — the duplicate-board prompt names an
 * existing board the user may not have in any loaded page (myBoards is
 * paginated), and it has to be resolved inside the tap handler. It also backs
 * the active-board self-heal: the backend follows merge tombstones, so a
 * merged-away uuid resolves to the surviving canonical board (a *different*
 * uuid) while a plain-deleted board resolves to `null`.
 */
export async function fetchBoardByUuid(boardUuid: string): Promise<UserBoard | null> {
  const data = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, { boardUuid });
  return data.board;
}

// `fetchAllMyBoards` — the paginated companion to `fetchBoardByUuid` — lives in
// its own module rather than here: the walk needs a unit test, and this barrel
// can't be imported under Vitest (it statically reaches react-native's Flow
// source, which Rolldown's scan refuses; see the `hooks-dual-write` exclusion in
// packages/mobile/vite.config.ts). Re-exported so callers keep one import path.
export { fetchAllMyBoards } from './fetch-all-my-boards';

/**
 * A single gym by uuid, including the viewer's `canEdit` flag. Backs the
 * gym-edit screen (moderators reach it from the wall finder's edit affordance).
 * Disabled until a uuid resolves so the edit screen can pass `null` while routing.
 */
export function useGym(gymUuid: string | null) {
  return useQuery({
    queryKey: ['gym', gymUuid],
    queryFn: () => getHttpClient().request<GetGymQueryResponse>(GET_GYM, { gymUuid }),
    select: (data) => data.gym,
    enabled: !!gymUuid,
  });
}

/**
 * The gyms the signed-in user owns (and, once the backend broadens it, gyms they
 * help run). Backs the "My gyms" screen off the More tab. The `myGyms` query
 * scopes to the caller server-side, so no owner filter is passed here. Disabled
 * until signed in — an anonymous caller has no gyms and the query would 401.
 *
 * Requests the server-max page (50) in one shot rather than paginating: an owner
 * runs a handful of gyms, so 50 clears every realistic case and keeps the screen a
 * plain list instead of an `onEndReached` drain.
 */
export function useMyGyms(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['myGyms'],
    queryFn: () => getHttpClient().request<GetMyGymsQueryResponse>(GET_MY_GYMS, { input: { limit: 50 } }),
    select: (data) => data.myGyms,
    enabled: options?.enabled ?? true,
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

/**
 * Resolve boards for a set of serial numbers outside a hook — backs the create
 * flow's pre-submit serial-reuse check, where the lookup runs imperatively in a
 * submit handler rather than as a query.
 */
export function fetchBoardsBySerialNumbers(serialNumbers: string[]): Promise<UserBoard[]> {
  return getHttpClient()
    .request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, { serialNumbers })
    .then((data) => data.boardsBySerialNumbers);
}

/**
 * Resolve scanned controller serials to boards, scoped to the board type each
 * one advertised.
 *
 * Aurora numbers each board app separately, so a serial identifies a controller
 * only within a type. Without `advertisedTypes` this returns whichever board
 * carries the number — which is how an in-range Tension controller could be
 * offered as a stranger's Kilter board, and made active.
 *
 * The `boardType` argument only narrows the request (and a mixed scan can't use
 * it at all); the per-serial `matchesAdvertisedType` filter below is what
 * actually enforces the rule.
 */
export function useBoardsBySerialNumbers(serialNumbers: string[], advertisedTypes: AdvertisedBoardTypes = new Map()) {
  // Sorted entries, not the map, so the key hashes stably across renders while
  // still changing when a late-arriving device name reveals a type. Memoized to
  // match useResolvedBleDeviceBoards: React Query's structural hashing already
  // prevents a spurious refetch, so this is about not re-sorting on every render
  // during a live scan (mobile performance checklist).
  const advertisedTypeEntries = useMemo(
    () => [...advertisedTypes].sort(([first], [second]) => first.localeCompare(second)),
    [advertisedTypes],
  );
  const boardType = useMemo(() => sharedAdvertisedBoardType(advertisedTypes), [advertisedTypes]);
  return useQuery({
    queryKey: ['boardsBySerialNumbers', serialNumbers, advertisedTypeEntries],
    queryFn: () =>
      getHttpClient().request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, {
        serialNumbers,
        boardType,
      }),
    select: (data) =>
      data.boardsBySerialNumbers.filter((board) =>
        board.serialNumber ? matchesAdvertisedType(board.serialNumber, board.boardType, advertisedTypes) : true,
      ),
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
  // Filter to these layout / size ids (OR). Board-type-scoped on the UI side.
  layoutIds?: number[],
  sizeIds?: number[],
) {
  // Empty string means "no name filter" to the resolver; normalise to undefined
  // so the cache key and the request payload stay clean.
  const nameFilter = query && query.trim().length > 0 ? query.trim() : undefined;
  const typeFilter = boardTypes && boardTypes.length > 0 ? boardTypes : undefined;
  const layoutFilter = layoutIds && layoutIds.length > 0 ? layoutIds : undefined;
  const sizeFilter = sizeIds && sizeIds.length > 0 ? sizeIds : undefined;
  return useQuery({
    queryKey: [
      'nearbyBoards',
      coords,
      radiusKm,
      nameFilter,
      limit,
      typeFilter ?? null,
      layoutFilter ?? null,
      sizeFilter ?? null,
    ],
    queryFn: () =>
      getHttpClient().request<SearchBoardsQueryResponse>(SEARCH_BOARDS, {
        input: {
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          radiusKm,
          limit,
          query: nameFilter,
          boardTypes: typeFilter,
          layoutIds: layoutFilter,
          sizeIds: sizeFilter,
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
  // Filter to gyms with a board matching these layout / size ids (OR). Combined
  // with boardTypes, all must match the SAME board (backend ANDs them in one
  // EXISTS). Board-type-scoped on the UI side.
  layoutIds?: number[],
  sizeIds?: number[],
  // Restrict to gyms with two or more distinct board types.
  multiBoardTypeOnly?: boolean,
  options?: { enabled?: boolean },
) {
  const nameFilter = query && query.trim().length > 0 ? query.trim() : undefined;
  const typeFilter = boardTypes && boardTypes.length > 0 ? boardTypes : undefined;
  const layoutFilter = layoutIds && layoutIds.length > 0 ? layoutIds : undefined;
  const sizeFilter = sizeIds && sizeIds.length > 0 ? sizeIds : undefined;
  const multiBoardTypeFilter = multiBoardTypeOnly ? true : undefined;
  return useQuery({
    queryKey: [
      'nearbyGyms',
      coords,
      radiusKm,
      nameFilter,
      typeFilter ?? null,
      layoutFilter ?? null,
      sizeFilter ?? null,
      multiBoardTypeFilter ?? null,
    ],
    queryFn: () =>
      getHttpClient().request<SearchGymsQueryResponse>(SEARCH_GYMS, {
        input: {
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          radiusKm,
          limit: 50,
          query: nameFilter,
          boardTypes: typeFilter,
          layoutIds: layoutFilter,
          sizeIds: sizeFilter,
          multiBoardTypeOnly: multiBoardTypeFilter,
        },
      }),
    select: (data) => data.searchGyms,
    // A name search stands on its own: `searchGyms` falls back to a text-only
    // lookup without coordinates, so the gym picker still works for someone who
    // declined location permission.
    enabled: (options?.enabled ?? true) && (coords !== null || nameFilter !== undefined),
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
 * Edit a board the caller is authorised to edit (owner, or a community
 * admin/leader for the board type — the server enforces access via `canEdit`).
 * Config (layout/size/sets) can change too; existing ticks are preserved
 * server-side. Invalidate-only: `myBoards` carries enriched fields (counts,
 * sizeName) that can't be rebuilt client-side; also refresh the wall-finder
 * lists/pins so a moderator's edit from gym discovery shows without a reload.
 * Re-syncing the active board's denormalised AsyncStorage copy is the edit
 * screen's job — see `useSetActiveBoard`.
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
      void queryClient.invalidateQueries({ queryKey: ['nearbyBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['searchBoards'] });
    },
  });
}

/**
 * Edit a gym the viewer can edit (owner, gym admin, or community admin/leader
 * for one of its board types — the server enforces the access check). Invalidate
 * the single-gym cache plus the nearby-gym search results so the wall finder's
 * list/pins reflect the rename or visibility change without a manual reload.
 * Also refresh the board lists, whose rows render the gym's name (`gymName`), and
 * the My gyms list, whose rows render the gym's name/address.
 */
export function useUpdateGym() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateGymInput) => {
      const response = await getHttpClient().request<UpdateGymMutationResponse>(UPDATE_GYM, { input });
      return response.updateGym;
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['gym', updated.uuid] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyGyms'] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['myGyms'] });
    },
  });
}

/**
 * Link a board you own to a gym, or unlink it by passing `gymUuid: null`.
 * Linking to a gym you don't run is allowed when the board sits within 150 m of
 * it — the server decides, and rejects with "not authorized" when it's too far,
 * so the caller should surface that failure rather than assume success.
 */
export function useLinkBoardToGym() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { boardUuid: string; gymUuid: string | null }) => {
      const response = await getHttpClient().request<LinkBoardToGymMutationResponse>(LINK_BOARD_TO_GYM, { input });
      return response.linkBoardToGym;
    },
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['board', variables.boardUuid] });
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyGyms'] });
      void queryClient.invalidateQueries({ queryKey: ['gymBoards'] });
    },
  });
}

/**
 * The roster of a gym (owner, admins, editors, members) with each member's role.
 * Backs the write-access section on the gym-edit screen, where editors are given a
 * revoke action. Disabled until a uuid resolves.
 */
export function useGymMembers(gymUuid: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['gymMembers', gymUuid],
    queryFn: () => getHttpClient().request<GetGymMembersQueryResponse>(GET_GYM_MEMBERS, { input: { gymUuid } }),
    select: (data) => data.gymMembers,
    enabled: (options?.enabled ?? true) && !!gymUuid,
  });
}

/**
 * Grant a climber `editor` write access to a gym the viewer administers (owner,
 * gym admin, or community leader — the server enforces the grant permission).
 * Refresh the roster so the newly added editor appears, and the single-gym cache
 * in case the viewer's own capability flags change.
 */
export function useGrantGymWriteAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GrantGymWriteAccessInput) => {
      const response = await getHttpClient().request<GrantGymWriteAccessMutationResponse>(GRANT_GYM_WRITE_ACCESS, {
        input,
      });
      return response.grantGymWriteAccess;
    },
    onSuccess: (_granted, input) => {
      void queryClient.invalidateQueries({ queryKey: ['gymMembers', input.gymUuid] });
      void queryClient.invalidateQueries({ queryKey: ['gym', input.gymUuid] });
    },
  });
}

/**
 * Revoke a gym editor's write access. Refreshes the roster (the member drops back
 * to no role) and the single-gym cache.
 */
export function useRevokeGymWriteAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RevokeGymWriteAccessInput) => {
      const response = await getHttpClient().request<RevokeGymWriteAccessMutationResponse>(REVOKE_GYM_WRITE_ACCESS, {
        input,
      });
      return response.revokeGymWriteAccess;
    },
    onSuccess: (_revoked, input) => {
      void queryClient.invalidateQueries({ queryKey: ['gymMembers', input.gymUuid] });
      void queryClient.invalidateQueries({ queryKey: ['gym', input.gymUuid] });
    },
  });
}

/**
 * Start an ownership claim for a gym. With a `claimEmail` matching the gym's
 * website domain the server sends a verification email (`email_sent`); otherwise
 * the claim goes to admin review (`admin_review`), or lands immediately
 * (`approved`) when auto-approval is on and the gym is an unclaimed listing.
 * A domain mismatch rejects with a GraphQL error the caller surfaces inline.
 *
 * Only `approved` transfers ownership here, so that's the only status that
 * invalidates: the other two resolve later (emailed link, admin queue) and leave
 * the cached gym correct. Mirrors the `updateGym` invalidation set, since the
 * claimant's `canClaim` / edit access and gym membership all just changed.
 */
export function useRequestGymClaim() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RequestGymClaimInput) => {
      const response = await getHttpClient().request<RequestGymClaimMutationResponse>(REQUEST_GYM_CLAIM, { input });
      return response.requestGymClaim;
    },
    onSuccess: (result, input) => {
      if (result.status !== 'approved') return;
      void queryClient.invalidateQueries({ queryKey: ['gym', input.gymUuid] });
      void queryClient.invalidateQueries({ queryKey: ['gymMembers', input.gymUuid] });
      void queryClient.invalidateQueries({ queryKey: ['myGyms'] });
      void queryClient.invalidateQueries({ queryKey: ['nearbyGyms'] });
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
 * Follow someone else's public board so it lands in the user's My Boards list.
 * Takes the board (uuid + name) rather than a bare uuid so `onFollowed` can name
 * it. Idempotent on the server (`onConflictDoNothing`), so callers can fire it
 * without first checking whether the board is already followed. Invalidates
 * `myBoards` so the newly-followed board shows up.
 *
 * Used both by board discovery's adopt flow and by the create-board serial-reuse
 * flow ("Use the existing board" — see `boards/create.tsx`), which awaits
 * `mutateAsync` before navigating away rather than relying on the config
 * callbacks below.
 *
 * `onFollowed` runs from the config-level `onSuccess` — which the mutation itself
 * invokes, so it still fires after the calling screen unmounts. The adopt flow
 * navigates away before the follow resolves, so a per-call `mutate(_, {onSuccess})`
 * callback (gated on the observer still having listeners) would be dropped. UI
 * concerns (toast copy) stay with the caller via this injected callback.
 */
export function useFollowBoard(options?: {
  onFollowed?: (board: Pick<UserBoard, 'uuid' | 'name'>) => void;
  onFollowError?: (board: Pick<UserBoard, 'uuid' | 'name'>, error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (board: Pick<UserBoard, 'uuid' | 'name'>) => {
      const response = await getHttpClient().request<FollowBoardMutationResponse>(FOLLOW_BOARD, {
        input: { boardUuid: board.uuid },
      });
      return response.followBoard;
    },
    onSuccess: (_followed, board) => {
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      options?.onFollowed?.(board);
    },
    // Config-level (survives unmount, like onSuccess). A rejected follow otherwise
    // fails silently after we've navigated away — surface it to the caller.
    onError: (error, board) => {
      options?.onFollowError?.(board, error);
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

// Bundled grade taxonomy for the cold-offline case: grades are static V↔Font
// data, so the grade-range rail works with no signal even if the network grades
// were never fetched. Online refetches the board's real list.
//
// Board-aware, because the full 10-33 scale is not what every board offers:
// MoonBoard starts at 6A and Woods only carries the V-bands its own app grades
// in. Cold-offline used to hand every board the whole scale, so MoonBoard's rail
// offered sub-6A stops its online list never had — the offline rail now matches
// the online filter on both boards.
//
// Memoised per board name so the query's `placeholderData` is referentially
// stable: a fresh object each render reads as new data to React Query and
// re-runs `select` (and every grade consumer) on every render.
const offlineGradesByBoard = new Map<string, { grades: Grade[] }>();

function getOfflineGrades(boardName: string): { grades: Grade[] } {
  const cached = offlineGradesByBoard.get(boardName);
  if (cached) return cached;
  // An unrecognised board falls back to Kilter's full scale — the same list the
  // pre-board-aware code handed everyone, so an unknown board is never worse off.
  const grades = getGradesForBoard(toBoardName(boardName) ?? 'kilter').map((grade) => ({
    difficultyId: grade.difficulty_id,
    name: grade.difficulty_name,
  }));
  const response = { grades };
  offlineGradesByBoard.set(boardName, response);
  return response;
}

export function useGrades(boardName: string, enabled = true) {
  const offlineGrades = getOfflineGrades(boardName);
  return useQuery({
    queryKey: ['grades', boardName],
    queryFn: () => {
      // Grades are the same static data online/offline, so (unlike search) the
      // offline flag stays OUT of the key — no cache miss / refetch on every flip.
      if (!onlineManager.isOnline()) return offlineGrades;
      return getHttpClient().request<GetGradesQueryResponse>(GET_GRADES, { boardName });
    },
    select: (data) => data.grades,
    staleTime: 24 * 60 * 60 * 1000,
    // Bundled grades render immediately (and cover a cold-offline start); the
    // network refines the board's real list when online.
    placeholderData: offlineGrades,
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
  // Keyed on input only — offlineAwareRequest is local-first and picks the source
  // live; a completed board sync invalidates ['searchClimbs'] to refresh it.
  return useQuery({
    queryKey: ['searchClimbs', input],
    queryFn: () => offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input }),
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
    queryFn: () => offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input }),
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
    queryFn: () => offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, variables!),
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
      void queryClient.invalidateQueries({ queryKey: ['infiniteSearchClimbs'] });
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

/**
 * Edit a session's name and/or notes (the creator-only `updateSession`
 * mutation). Omitting a field leaves it unchanged; an empty/whitespace value
 * clears it — the server enforces both. Works on active and ended sessions.
 *
 * Invalidation lives on the config-level `onSuccess` (not a per-call callback):
 * the summary route can navigate away before the mutation resolves, and an
 * observer-gated `mutate(_, { onSuccess })` would be dropped after unmount.
 * Refreshes this session's detail + summary caches plus the grouped/activity
 * feeds, whose rows carry the session's notes.
 */
export function useUpdateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: UpdateSessionVariables) => {
      const response = await getHttpClient().request<UpdateSessionResponse>(UPDATE_SESSION, variables);
      return response.updateSession;
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['sessionDetail', updated.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['sessionSummary', updated.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['activityFeed'] });
    },
  });
}

// ============================================
// Mutations
// ============================================

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const offlineEnabled = useOfflineDownloadsEnabled();

  return useMutation({
    mutationFn: async (variables: ToggleFavoriteVariables) => {
      const db = getDatabaseHandle();
      // Local-first only with the offline flag on; otherwise the plain network
      // toggle below — pre-offline behavior.
      if (offlineEnabled && db && typeof variables.currentlyFavorited === 'boolean') {
        if (variables.currentlyFavorited) {
          await removeFavoriteLocal(db, variables.input);
        } else {
          await addFavoriteLocal(db, variables.input);
        }

        const favorited = !variables.currentlyFavorited;
        // Pin the per-climb heart optimistically instead of refetching: a
        // network refetch here races the queued mutation and can cache the
        // PRE-toggle state for 5 minutes. The drainer invalidates
        // ['favoriteStatus'] once the queued write actually lands. The cached
        // shape is the RAW GET_FAVORITES response (select runs on read).
        queryClient.setQueryData(
          ['favoriteStatus', variables.input.boardName, variables.input.climbUuid, variables.input.angle],
          { favorites: favorited ? [variables.input.climbUuid] : [] },
        );

        scheduleDrain(db, queryClient);

        return { toggleFavorite: { favorited }, viaLocalQueue: true as const };
      }

      return getHttpClient().request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, {
        input: variables.input,
      });
    },
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['infiniteSearchClimbs'] });
      // Bust the per-climb favorite-status cache so a re-open reflects the new
      // state from the server, not a stale 5-min-cached value. Skipped on the
      // local-queue path, where the server does not know about the toggle yet —
      // the optimistic setQueryData above holds until the drainer's
      // post-landing invalidation.
      if (!('viaLocalQueue' in data)) {
        void queryClient.invalidateQueries({
          queryKey: ['favoriteStatus', variables.input.boardName, variables.input.climbUuid, variables.input.angle],
        });
      }
    },
  });
}

/**
 * Server-side favorite status for a single climb at the given angle. The
 * favorite key is (userId, boardName, climbUuid, angle) on the backend, so the
 * angle matters — favoriting at 40° is distinct from 25°. Disabled until a
 * `climbUuid` is supplied (and via `enabled`, so callers can gate it on a sheet
 * being open). Returns `true` when the climb is favorited at this angle.
 *
 * The session is part of the gate, not just the caller's `enabled`. `favorites`
 * is `requireAuthenticated` server-side, so for a signed-out reader this query
 * has exactly one outcome: an error. That used to be theoretical — nothing
 * signed-out could open the play drawer — and stopped being so when the web
 * export began rendering read-only climb URLs anonymously, where the drawer
 * opens with `enabled: isSheetOpen` and fires a guaranteed rejection on every
 * open. Gating here rather than only at the call site means a future consumer
 * cannot reintroduce it by forgetting.
 *
 * The cost is a provider dependency this hook did not used to have: it reads the
 * session off `useBoardAdapter()`, so it must be called under a
 * `BoardAdapterProvider` — mounted app-wide in `app/_layout.tsx` — and throws at
 * the hook rather than at query time outside one.
 */
export function useFavoriteStatus(
  boardName: string,
  climbUuid: string | null,
  angle: number,
  options?: { enabled?: boolean },
) {
  const { isAuthenticated } = useBoardAdapter();
  return useQuery({
    queryKey: ['favoriteStatus', boardName, climbUuid, angle],
    queryFn: () =>
      getHttpClient().request<FavoritesQueryResponse, FavoritesQueryVariables>(GET_FAVORITES, {
        boardName,
        climbUuids: [climbUuid!],
        angle,
      }),
    select: (data) => data.favorites.includes(climbUuid!),
    enabled: (options?.enabled ?? true) && !!climbUuid && isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
}

// ============================================
// Beta Videos (Instagram + TikTok per climb)
// ============================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * The nightly data-science Boardsesh grade for a climb at a given angle. Nullable
 * — the resolver returns null until the job has computed a row. `climbUuid` null
 * disables the query. Scoped by angle: the grade at 40° differs from 25°.
 */
export function useBoardseshGrade(
  boardName: string,
  climbUuid: string | null,
  angle: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    // offlineAwareRequest serves this from local board_climb_grades when the
    // board type is downloaded (offline, and local-first while online); a
    // completed board sync invalidates ['boardseshGrade'] to refresh it.
    queryKey: ['boardseshGrade', boardName, climbUuid, angle],
    queryFn: () =>
      offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, {
        boardName,
        climbUuid: climbUuid!,
        angle,
      }),
    select: (data) => data.boardseshGrade,
    enabled: (options?.enabled ?? true) && !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Every computed Boardsesh grade for a climb, one row per angle (ascending).
 * Fetches the whole per-angle list in one request so the angle picker can show
 * the grade at each angle without a query per angle. `climbUuid` null disables
 * the query.
 */
export function useBoardseshGradesForAngles(
  boardName: string,
  climbUuid: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    // Local-first via offlineAwareRequest (reads all synced angles from
    // board_climb_grades when the board type is downloaded).
    queryKey: ['boardseshGradesForAngles', boardName, climbUuid],
    queryFn: () =>
      offlineAwareRequest<BoardseshGradesForAnglesResponse>(BOARDSESH_GRADES_FOR_ANGLES, {
        boardName,
        climbUuid: climbUuid!,
      }),
    select: (data) => data.boardseshGradesForAngles,
    enabled: (options?.enabled ?? true) && !!climbUuid,
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
  useUserGroupedAscentsFeed,
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
export { useSessionDetail, useSessionPreview, useSessionOwnerUserId } from './use-session-detail';
// `use-notifications` is deliberately NOT re-exported here. Its `enabled` gate
// reads the stored auth token, so the module reaches expo-secure-store — and
// this barrel is imported by suites that mock only the GraphQL client, where
// any new native reach makes Rolldown's scan hit react-native's Flow source and
// fail the whole file. Its three consumers import it by path instead.
export { useDeleteAccountInfo, useDeleteAccount } from './use-delete-account';
export {
  useIntegrationStatuses,
  useDisconnectIntegration,
  useSetIntegrationAutoSync,
  useSyncSessionToIntegration,
} from './use-integrations';
