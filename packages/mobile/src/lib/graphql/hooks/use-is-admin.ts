import { useQuery } from '@tanstack/react-query';
import { getHttpClient } from '../client';
import { GET_PROFILE_ADMIN_FLAG, type GetProfileAdminFlagQueryResponse } from '../operations';

/**
 * Is the viewer an admin? Its own query document, not a field on `useProfile`.
 *
 * `UserProfile.isAdmin` reaches production in a backend deploy that lands after
 * this JS does, so asking for it inside `GET_PROFILE` would fail that whole
 * query — and blank the You tab — for every user until the two lined up. Here a
 * miss is contained: the query errors, `data` stays undefined, and the flag
 * reads false. Fail-closed is the right default for an admin gate anyway.
 */
export function useIsAdmin(options?: { enabled?: boolean }): { isAdmin: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['profileAdminFlag'],
    queryFn: () => getHttpClient().request<GetProfileAdminFlagQueryResponse>(GET_PROFILE_ADMIN_FLAG),
    select: (data) => data.profile?.isAdmin ?? false,
    enabled: options?.enabled ?? true,
    // One retry only: an old backend rejects this document every time, and the
    // gate should settle to "no" quickly rather than spin.
    retry: 1,
  });
  return { isAdmin: query.data ?? false, isLoading: query.isLoading };
}
