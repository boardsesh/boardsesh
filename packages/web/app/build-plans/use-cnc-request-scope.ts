'use client';

import { useCallback, useEffect, useRef } from 'react';

/** In-flight mutations must not update a new session or redirect after unmount. */
export function useCncRequestScope(authToken: string | null): () => () => boolean {
  const scope = useRef({ authToken, version: 0, mounted: true });
  if (scope.current.authToken !== authToken) {
    scope.current.authToken = authToken;
    scope.current.version += 1;
  }
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
