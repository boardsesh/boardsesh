'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * OwnedConfigurator and OwnedOrderStatus remount for every owner/login change.
 * Fence requests to that lifetime, allowing credentials to rotate within one login.
 */
export function useCncRequestScope(): () => () => boolean {
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
    return () => scope.current.mounted && scope.current.version === version;
  }, []);
}
