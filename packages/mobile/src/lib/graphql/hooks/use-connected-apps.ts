import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { withoutConnectedApp } from '@boardsesh/connected-apps';
import {
  DISCONNECT_APP,
  GET_MY_CONNECTED_APPS,
  GET_PARTNER_APPS_ENABLED,
  type DisconnectAppResponse,
  type DisconnectAppVariables,
  type GetMyConnectedAppsResponse,
  type GetPartnerAppsEnabledResponse,
} from '@boardsesh/graphql/operations/connected-apps';
import { useAuth } from '../../../providers/auth-provider';
import { getHttpClient } from '../client';

export const CONNECTED_APPS_QUERY_KEY = ['myConnectedApps'] as const;
export const PARTNER_APPS_ENABLED_QUERY_KEY = ['partnerAppsEnabled'] as const;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether partner apps are switched on, for the notes that mention them (the
 * draft switch). The answer changes only with a deploy, so one request an hour at
 * most, shared by every screen that asks; never one per editor open. A failure
 * (offline, an older server, an error) is cached as `false` for the same hour,
 * rather than left as an error React Query would retry on the next mount: the
 * note fails closed, and a broken backend costs one request an hour, not one per
 * open.
 */
export function usePartnerAppsEnabled(): boolean {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: PARTNER_APPS_ENABLED_QUERY_KEY,
    queryFn: async (): Promise<GetPartnerAppsEnabledResponse> => {
      try {
        return await getHttpClient().request<GetPartnerAppsEnabledResponse>(GET_PARTNER_APPS_ENABLED);
      } catch {
        return { partnerAppsEnabled: false };
      }
    },
    select: (response) => response.partnerAppsEnabled,
    enabled: isAuthenticated,
    staleTime: HOUR_MS,
    gcTime: 24 * HOUR_MS,
    retry: false,
  });
  return data === true;
}

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
