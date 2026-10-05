import { useInfiniteQuery } from '@tanstack/react-query';
import {
  GET_PUBLIC_SUPPORTERS,
  type GetPublicSupportersResponse,
  type GetPublicSupportersVariables,
} from '@boardsesh/graphql/operations/support';
import { getHttpClient } from '../client';
import { screenshotModeNextPageParam } from '../../screenshot-mode';

export const MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE = 30;

export function usePublicSupporters() {
  return useInfiniteQuery({
    queryKey: ['publicSupporters', 'infinite'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getHttpClient().request<GetPublicSupportersResponse, GetPublicSupportersVariables>(GET_PUBLIC_SUPPORTERS, {
        limit: MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage, pages, lastPageParam) =>
      screenshotModeNextPageParam(
        lastPage.publicSupporters.length === MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE
          ? lastPageParam + MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE
          : undefined,
        pages.length,
      ),
    staleTime: 5 * 60 * 1000,
  });
}
