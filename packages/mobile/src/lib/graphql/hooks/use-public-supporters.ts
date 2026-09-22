import { useQuery } from '@tanstack/react-query';
import {
  fetchAllPublicSupporters,
  GET_PUBLIC_SUPPORTERS,
  type GetPublicSupportersResponse,
  type GetPublicSupportersVariables,
} from '@boardsesh/graphql/operations/support';
import { getHttpClient } from '../client';

export function usePublicSupporters() {
  return useQuery({
    queryKey: ['publicSupporters'],
    queryFn: () =>
      fetchAllPublicSupporters((variables) =>
        getHttpClient().request<GetPublicSupportersResponse, GetPublicSupportersVariables>(
          GET_PUBLIC_SUPPORTERS,
          variables,
        ),
      ),
    staleTime: 5 * 60 * 1000,
  });
}
