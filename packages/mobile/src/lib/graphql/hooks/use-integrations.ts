import { useQueryClient } from '@tanstack/react-query';
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
import { useHttpQuery } from '../use-http-query';
import { useHttpMutation } from '../use-http-mutation';
import { createHttpScopedCache } from '../http-scoped-cache';

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
  return useHttpQuery({
    queryKey: INTEGRATION_STATUSES_KEY,
    queryFn: (_context, operation) => operation.request<GetIntegrationsResponse>(GET_INTEGRATIONS),
    select: (data) => data.integrations,
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

/** Disconnect a server-side integration. Refetches statuses and tracks the
 *  disconnection on success. */
export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useHttpMutation({
    mutationFn: (variables: DisconnectIntegrationVariables, operation) =>
      operation.request<DisconnectIntegrationResponse>(DISCONNECT_INTEGRATION, variables),
    onSuccess: (_data, variables, _context, operation) => {
      void operation
        .cache(queryClient)
        .invalidateQueries({ queryKey: INTEGRATION_STATUSES_KEY })
        .catch(() => {});
      operation.assertDeliveries();
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
  return useHttpMutation({
    mutationFn: (variables: SetIntegrationAutoSyncVariables, operation) =>
      operation.request<SetIntegrationAutoSyncResponse>(SET_INTEGRATION_AUTO_SYNC, variables),
    onMutate: async (variables, operation) => {
      const cache = createHttpScopedCache({
        client: queryClient,
        key: operation.key,
        assertCurrent: operation.assertView,
      });
      await cache.cancelQueries({ queryKey: INTEGRATION_STATUSES_KEY });
      const previous = cache.getQueryData<GetIntegrationsResponse>(INTEGRATION_STATUSES_KEY);
      cache.setQueryData<GetIntegrationsResponse>(INTEGRATION_STATUSES_KEY, (current) => {
        if (!current) return current;
        return {
          integrations: current.integrations.map((status) =>
            status.provider === variables.provider ? { ...status, autoSyncEnabled: variables.enabled } : status,
          ),
        };
      });
      return { previous };
    },
    onError: (_error, _variables, context, operation) => {
      if (context?.previous) {
        createHttpScopedCache({
          client: queryClient,
          key: operation.key,
          assertCurrent: operation.assertView,
        }).setQueryData(INTEGRATION_STATUSES_KEY, context.previous);
      }
    },
    onSettled: (_result, error, _variables, _context, operation) => {
      const cache = error
        ? createHttpScopedCache({ client: queryClient, key: operation.key, assertCurrent: operation.assertView })
        : operation.cache(queryClient);
      void cache.invalidateQueries({ queryKey: INTEGRATION_STATUSES_KEY }).catch(() => {});
    },
    onSuccess: (_data, variables, _context, operation) => {
      operation.assertDeliveries();
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
  return useHttpMutation({
    mutationFn: (variables: SyncSessionToIntegrationVariables, operation) =>
      operation.request<SyncSessionToIntegrationResponse>(SYNC_SESSION_TO_INTEGRATION, variables),
    onSuccess: (data, variables, _context, operation) => {
      // A resolved mutation can still carry a domain-level upload failure in
      // `error` (the resolver returns rather than throws so the UI can toast
      // it) — that must not count as a successful export.
      if (!data.syncSessionToIntegration.error) {
        operation.assertDeliveries();
        track(SHARED_EVENTS.SessionExportedToIntegration, {
          integration: analyticsIntegrationName(variables.provider),
          trigger: 'manual',
        });
      }
    },
  });
}
