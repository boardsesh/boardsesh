import type { QueryClient } from '@tanstack/react-query';
import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createBrowserBackendRequestAuthority } from '@boardsesh/auth-protocol/browser-backend-request-authority';
import {
  holdSyncRequest,
  capturePurgeToken,
  hasPurgeLanded,
  isSigningOut,
  isBackgrounded,
  type CapturedSyncSession,
  type GraphQLFetch,
  type QueryInvalidator,
} from '@boardsesh/offline-sync';
import {
  captureAuthCredentialGeneration,
  isAuthCredentialGenerationCurrent,
  isRequiredBrowserDispatch,
} from '../lib/auth-store.web';
import { expoBrowserBackendClient } from '../lib/browser-backend-client.web';
import { browserHttpClients } from '../lib/graphql/client.web';
import { createHttpOperation } from '../lib/graphql/http-operation.web';
import type { OfflineNetworkStart } from './offline-network-context';

type Operation = ReturnType<typeof createHttpOperation>;
const admitted = new WeakSet<object>();

/** I/O is injected for owned integration tests; production binds the same actual
 * manager, view registry and SDK operations used by other selected consumers. */
export function createOfflineNetworkCapture(provided: {
  backendClient: ReturnType<typeof createBrowserBackendClient>;
  captureGeneration: () => number;
  isGenerationCurrent: (generation: number) => boolean;
  required: () => boolean;
  captureView: () => string | undefined;
  isCurrentView: (scope: string | undefined) => boolean;
  prefix: (scope: string | undefined) => readonly unknown[];
  createOperation: (scope: string | undefined) => Operation;
}) {
  const options = Object.freeze({ ...provided });
  return (readLegacyUserId: () => Promise<string | undefined>): OfflineNetworkStart => {
    const purge = capturePurgeToken();
    const scope = options.captureView();
    const generation = options.captureGeneration();
    const selected = options.required() || options.backendClient.isSelected();
    const prefix = Object.freeze([...options.prefix(scope)]);
    let disposed = false;
    let authority: ReturnType<typeof createBrowserBackendRequestAuthority> | undefined;
    let captureFailed = false;
    if (selected) {
      try {
        authority = createBrowserBackendRequestAuthority({
          client: options.backendClient,
          captureGeneration: options.captureGeneration,
          isGenerationCurrent: options.isGenerationCurrent,
        });
      } catch {
        captureFailed = true;
      }
    }
    const assertOriginal = () => {
      if (
        disposed ||
        captureFailed ||
        isSigningOut() ||
        isBackgrounded() ||
        hasPurgeLanded(purge) ||
        !options.isGenerationCurrent(generation) ||
        !options.isCurrentView(scope) ||
        (selected ? !authority?.isCurrent() : options.required() || options.backendClient.isSelected())
      )
        throw holdSyncRequest();
    };
    return Object.freeze({
      async resolve() {
        try {
          assertOriginal();
          let userId: string | undefined;
          if (selected) {
            const lease = await authority!.acquire();
            assertOriginal();
            authority!.assertCurrent(lease);
            userId = lease.owner.userId;
          } else {
            userId = await readLegacyUserId();
            assertOriginal();
          }
          if (!userId) throw holdSyncRequest();
          let network: CapturedSyncSession;
          const assertView = () => {
            assertOriginal();
            if (selected && !admitted.has(network)) throw holdSyncRequest();
          };
          network = Object.freeze({
            kind: selected ? 'selected' : 'legacy',
            userId,
            assertView,
            beginRequest() {
              assertView();
              const operation = options.createOperation(scope);
              const assertRequest = () => {
                try {
                  assertView();
                  operation.assertView();
                } catch {
                  throw holdSyncRequest();
                }
              };
              const assertDeliveries = () => {
                try {
                  assertRequest();
                  operation.assertDeliveries();
                } catch {
                  throw holdSyncRequest();
                }
              };
              const assertErrorDeliveries = (error: unknown) => {
                try {
                  assertRequest();
                  operation.assertErrorDeliveries(error);
                } catch {
                  throw holdSyncRequest();
                }
              };
              let previous: 'none' | 'success' | 'error' = 'none';
              let previousError: unknown;
              const fetch: GraphQLFetch = async <Result>(
                query: string,
                variables?: Record<string, unknown>,
              ): Promise<Result> => {
                assertRequest();
                if (previous === 'success') assertDeliveries();
                else if (previous === 'error') assertErrorDeliveries(previousError);
                let result: Result;
                try {
                  result = await operation.request<Result>(query, variables);
                } catch (error) {
                  if (selected) assertErrorDeliveries(error);
                  else assertRequest();
                  previous = 'error';
                  previousError = error;
                  throw error;
                }
                assertDeliveries();
                previous = 'success';
                return result;
              };
              return Object.freeze({
                kind: selected ? ('selected' as const) : ('legacy' as const),
                fetch,
                assertView: assertRequest,
                assertDeliveries,
                assertErrorDeliveries,
                dispose: () => operation.dispose(),
              });
            },
            dispose() {
              disposed = true;
              authority?.dispose();
            },
          });
          if (selected) admitted.add(network);
          assertView();
          return Object.freeze({
            network,
            bindInvalidator(client: QueryClient): QueryInvalidator {
              if (!selected) return client;
              return Object.freeze({
                invalidateQueries(
                  filters: Parameters<QueryInvalidator['invalidateQueries']>[0],
                  invalidateOptions?: Parameters<QueryInvalidator['invalidateQueries']>[1],
                ) {
                  assertView();
                  const predicate = filters.predicate;
                  return client.invalidateQueries(
                    {
                      ...filters,
                      queryKey: [...prefix, ...filters.queryKey],
                      ...(predicate
                        ? {
                            predicate: (query) => {
                              assertView();
                              if (!prefix.every((part, index) => query.queryKey[index] === part)) return false;
                              const matches = predicate({ queryKey: query.queryKey.slice(prefix.length) });
                              assertView();
                              return matches;
                            },
                          }
                        : {}),
                    },
                    invalidateOptions,
                  );
                },
              });
            },
          });
        } catch {
          disposed = true;
          authority?.dispose();
          throw holdSyncRequest();
        }
      },
    });
  };
}

export const captureOfflineNetworkContext = createOfflineNetworkCapture({
  backendClient: expoBrowserBackendClient,
  captureGeneration: captureAuthCredentialGeneration,
  isGenerationCurrent: isAuthCredentialGenerationCurrent,
  required: isRequiredBrowserDispatch,
  captureView: browserHttpClients.captureRequestView,
  isCurrentView: browserHttpClients.isCurrentView,
  prefix: (scope) => browserHttpClients.queryKey([], scope),
  createOperation: (scope) => createHttpOperation(scope, { mode: 'offline' }),
});
