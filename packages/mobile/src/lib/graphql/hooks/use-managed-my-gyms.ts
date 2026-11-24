import { useInfiniteQuery } from '@tanstack/react-query';
import { GET_MY_GYMS, type GetMyGymsQueryResponse, type GetMyGymsQueryVariables } from '@boardsesh/graphql';
import { getHttpClient } from '../client';
import { requestForGymViewer } from './use-gym-reporting';

const PAGE_SIZE = 50;

export function useManagedMyGyms(viewerId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['myGyms', viewerId, 'managed'],
    enabled: !!viewerId,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      if (!viewerId) throw new Error('A signed-in viewer is required');
      const result = await requestForGymViewer(viewerId, () =>
        getHttpClient().request<GetMyGymsQueryResponse, GetMyGymsQueryVariables>({
          document: GET_MY_GYMS,
          signal,
          variables: { input: { includeManaged: true, limit: PAGE_SIZE, offset: pageParam } },
        }),
      );
      return result.myGyms;
    },
    getNextPageParam: (lastPage, _pages, offset) =>
      lastPage.hasMore && lastPage.gyms.length > 0 ? offset + lastPage.gyms.length : undefined,
  });
}
