import type { PopularBoardConfigsInput } from '@boardsesh/shared-schema';
import {
  GET_GYM,
  GET_MY_GYMS,
  type GetGymQueryResponse,
  type GetMyGymsQueryResponse,
} from '@boardsesh/graphql/operations/gyms';
import { GET_BOARD_BY_SLUG, type GetBoardBySlugQueryResponse } from '@boardsesh/graphql/operations/boards';
import {
  GET_BOARD,
  GET_POPULAR_BOARD_CONFIGS,
  type GetBoardQueryResponse,
  type GetPopularBoardConfigsQueryResponse,
} from '../operations';
import { useHttpQuery } from '../use-http-query';

export function useBoard(boardUuid: string | null) {
  return useHttpQuery({
    queryKey: ['board', boardUuid],
    queryFn: (_context, operation) => operation.request<GetBoardQueryResponse>(GET_BOARD, { boardUuid }),
    select: (data) => data.board,
    enabled: !!boardUuid,
  });
}

/**
 * A single gym by uuid, including the viewer's `canEdit` flag. Backs the
 * gym-edit screen (moderators reach it from the wall finder's edit affordance).
 * Disabled until a uuid resolves so the edit screen can pass `null` while routing.
 */
export function useGym(gymUuid: string | null) {
  return useHttpQuery({
    queryKey: ['gym', gymUuid],
    queryFn: (_context, operation) => operation.request<GetGymQueryResponse>(GET_GYM, { gymUuid }),
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
  return useHttpQuery({
    queryKey: ['myGyms'],
    queryFn: (_context, operation) => operation.request<GetMyGymsQueryResponse>(GET_MY_GYMS, { input: { limit: 50 } }),
    select: (data) => data.myGyms,
    enabled: options?.enabled ?? true,
  });
}

export function useBoardBySlug(slug: string | null, options?: { enabled?: boolean }) {
  return useHttpQuery({
    queryKey: ['boardBySlug', slug],
    queryFn: (_context, operation) => operation.request<GetBoardBySlugQueryResponse>(GET_BOARD_BY_SLUG, { slug }),
    select: (data) => data.boardBySlug,
    enabled: (options?.enabled ?? true) && !!slug,
  });
}

export function usePopularBoardConfigs(input?: PopularBoardConfigsInput, options?: { enabled?: boolean }) {
  return useHttpQuery({
    queryKey: ['popularBoardConfigs', input],
    queryFn: (_context, operation) =>
      operation.request<GetPopularBoardConfigsQueryResponse>(GET_POPULAR_BOARD_CONFIGS, { input }),
    select: (data) => data.popularBoardConfigs,
    // The popular set is server-cached and changes rarely; avoid refetch churn.
    staleTime: 60 * 60 * 1000,
    enabled: options?.enabled ?? true,
  });
}
