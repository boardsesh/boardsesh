import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  GET_INTEGRATIONS,
  DISCONNECT_INTEGRATION,
  SET_INTEGRATION_AUTO_SYNC,
  SYNC_SESSION_TO_INTEGRATION,
  type GetIntegrationsResponse,
  type DisconnectIntegrationVariables,
  type DisconnectIntegrationResponse,
  type SetIntegrationAutoSyncVariables,
  type SetIntegrationAutoSyncResponse,
  type SyncSessionToIntegrationVariables,
  type SyncSessionToIntegrationResponse,
} from '@boardsesh/graphql/operations/integrations';
import type { IntegrationProvider } from '@boardsesh/shared-schema';
import { useAuth } from '../../../providers/auth-provider';
import { track } from '../../analytics';
import { getHttpClient } from '../client';

const INTEGRATION_STATUSES_KEY = ['integrationStatuses'] as const;

/** Analytics name for a provider ('STRAVA' → 'strava') — never hardcode one
 *  provider here or future providers' events get misattributed. */
function analyticsIntegrationName(provider: IntegrationProvider): string {
  return provider.toLowerCase();
}

/**
 * Server-side integration statuses (Strava today). Gated on auth like the other
 * authenticated hooks in this directory — integrations are per-user, so there's
 * nothing to fetch while signed out. The query unwraps to
 * `IntegrationStatus[] | undefined`.
 */
export function useIntegrationStatuses() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: INTEGRATION_STATUSES_KEY,
    queryFn: () => getHttpClient().request<GetIntegrationsResponse>(GET_INTEGRATIONS),
    select: (data) => data.integrations,
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

/** Disconnect a server-side integration. Refetches statuses and tracks the
 *  disconnection on success. */
export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: DisconnectIntegrationVariables) =>
      getHttpClient().request<DisconnectIntegrationResponse>(DISCONNECT_INTEGRATION, variables),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUSES_KEY });
      track(SHARED_EVENTS.IntegrationDisconnected, { integration: analyticsIntegrationName(variables.provider) });
    },
  });
}

/**
 * Toggle server-side auto-sync for an integration, with an optimistic update so
 * the switch flips instantly: cancel in-flight fetches, snapshot, patch the
 * matching provider's `autoSyncEnabled`, roll back on error, and refetch on
 * settle to reconcile with the server.
 */
export function useSetIntegrationAutoSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: SetIntegrationAutoSyncVariables) =>
      getHttpClient().request<SetIntegrationAutoSyncResponse>(SET_INTEGRATION_AUTO_SYNC, variables),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: INTEGRATION_STATUSES_KEY });
      const previous = queryClient.getQueryData<GetIntegrationsResponse>(INTEGRATION_STATUSES_KEY);
      queryClient.setQueryData<GetIntegrationsResponse>(INTEGRATION_STATUSES_KEY, (current) => {
        if (!current) return current;
        return {
          integrations: current.integrations.map((status) =>
            status.provider === variables.provider ? { ...status, autoSyncEnabled: variables.enabled } : status,
          ),
        };
      });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(INTEGRATION_STATUSES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUSES_KEY });
    },
    onSuccess: (_data, variables) => {
      track(SHARED_EVENTS.IntegrationAutoSyncToggled, {
        integration: analyticsIntegrationName(variables.provider),
        enabled: variables.enabled,
      });
    },
  });
}

/** Sync a single finished session to a server-side integration (manual export
 *  from the summary screen). Tracks the export on success. */
export function useSyncSessionToIntegration() {
  return useMutation({
    mutationFn: (variables: SyncSessionToIntegrationVariables) =>
      getHttpClient().request<SyncSessionToIntegrationResponse>(SYNC_SESSION_TO_INTEGRATION, variables),
    onSuccess: (data, variables) => {
      // A resolved mutation can still carry a domain-level upload failure in
      // `error` (the resolver returns rather than throws so the UI can toast
      // it) — that must not count as a successful export.
      if (!data.syncSessionToIntegration.error) {
        track(SHARED_EVENTS.SessionExportedToIntegration, {
          integration: analyticsIntegrationName(variables.provider),
          trigger: 'manual',
        });
      }
    },
  });
}
