import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { withoutConnectedApp } from '@boardsesh/connected-apps';
import {
  DISCONNECT_APP,
  GET_MY_CONNECTED_APPS,
  type DisconnectAppResponse,
  type DisconnectAppVariables,
  type GetMyConnectedAppsResponse,
} from '@boardsesh/graphql/operations/connected-apps';
import { useAuth } from '../../../providers/auth-provider';
import { getHttpClient } from '../client';

export const CONNECTED_APPS_QUERY_KEY = ['myConnectedApps'] as const;

/**
 * The apps the signed-in climber connected through partner OAuth (#6981 F16).
 * Per climber, so nothing is fetched while signed out.
 */
export function useMyConnectedApps() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: CONNECTED_APPS_QUERY_KEY,
    queryFn: () => getHttpClient().request<GetMyConnectedAppsResponse>(GET_MY_CONNECTED_APPS),
    select: (data) => data.myConnectedApps,
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

/**
 * Ends one connection. On success the row leaves the cached list at once, then
 * the list is fetched again; on failure the list is left as it was.
 */
export function useDisconnectApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: DisconnectAppVariables) =>
      getHttpClient().request<DisconnectAppResponse>(DISCONNECT_APP, variables),
    onSuccess: (_data, { connectionId }) => {
      queryClient.setQueryData<GetMyConnectedAppsResponse>(CONNECTED_APPS_QUERY_KEY, (current) =>
        current ? { myConnectedApps: withoutConnectedApp(current.myConnectedApps, connectionId) } : current,
      );
      void queryClient.invalidateQueries({ queryKey: CONNECTED_APPS_QUERY_KEY });
    },
  });
}
