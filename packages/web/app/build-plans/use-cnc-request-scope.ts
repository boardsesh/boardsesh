'use client';

import { useCallback, useEffect, useRef } from 'react';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import { isCurrentBrowserBackendGraphQLResult } from '@/app/lib/auth/browser-backend-graphql';

/**
 * OwnedConfigurator and OwnedOrderStatus remount for every owner/login change.
 * Fence requests to that lifetime, allowing credentials to rotate within one login.
 */
export function useCncRequestScope(authToken: string | null): () => (response?: unknown) => boolean {
  const scope = useRef({ version: 0, mounted: true });
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
      scope.current.version += 1;
    };
  }, []);
  return useCallback(() => {
    const version = scope.current.version;
    const selected = browserBackendClient.isSelected() || authToken?.startsWith('bsbd1_') === true;
    // A component can still display A while SessionProvider awaits cleanup for
    // an already admitted B. Capture the caller's original opaque lease scope,
    // rather than whatever owner happens to be current when an await finishes.
    const selectedScope = selected && authToken ? browserBackendClient.capture(authToken) : null;
    return (response?: unknown) =>
      scope.current.mounted &&
      scope.current.version === version &&
      (selected
        ? selectedScope !== null && browserBackendClient.isCurrent(selectedScope)
        : !browserBackendClient.isSelected()) &&
      (response === undefined || isCurrentBrowserBackendGraphQLResult(response));
  }, [authToken]);
}
