import { useQuery } from '@tanstack/react-query';
import { GET_PUBLIC_SUPPORTERS, type GetPublicSupportersResponse } from '@boardsesh/graphql/operations/support';
import { getHttpClient } from '../client';

export function usePublicSupporters() {
  return useQuery({
    queryKey: ['publicSupporters'],
    queryFn: () => getHttpClient().request<GetPublicSupportersResponse>(GET_PUBLIC_SUPPORTERS),
    select: (response) => response.publicSupporters,
    staleTime: 5 * 60 * 1000,
  });
}
