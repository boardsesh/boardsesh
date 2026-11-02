import type { QueryClient } from '@tanstack/react-query';
import { createClimbProgressCacheScope } from './climb-progress-cache-scope';
import { getCredentialGeneration, subscribeToCredentialChanges } from './privacy/privacy-cache';

const cacheScopes = new WeakMap<QueryClient, ReturnType<typeof createClimbProgressCacheScope>>();

/** Register at client creation, before even disabled progress has cached ticks. */
export function climbProgressCacheScopeFor(queryClient: QueryClient) {
  let scope = cacheScopes.get(queryClient);
  if (!scope) {
    scope = createClimbProgressCacheScope(queryClient, getCredentialGeneration());
    cacheScopes.set(queryClient, scope);
    const ownerScope = scope;
    // One passive ownership guard for the app client's lifetime, including
    // when progress has never been enabled. It starts no reads or requests.
    subscribeToCredentialChanges(() => ownerScope.setGeneration(getCredentialGeneration()));
  }
  return scope;
}
