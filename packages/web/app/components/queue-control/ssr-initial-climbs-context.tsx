'use client';

import React, { createContext, useContext, useMemo } from 'react';
import type { Climb } from '@/app/lib/types';

interface SSRInitialClimbsData {
  climbs: Climb[];
  hasMore: boolean;
}

const SSRInitialClimbsContext = createContext<SSRInitialClimbsData | null>(null);

interface SSRInitialClimbsProviderProps {
  initialClimbs: Climb[];
  hasMore: boolean;
  children: React.ReactNode;
}

/**
 * Provides SSR-fetched climb data to client-side TanStack Query via context.
 * This bridges the gap between page.tsx (which fetches initial data server-side)
 * and useQueueDataFetching (which lives in the layout's GraphQLQueueProvider).
 *
 * When present, TanStack Query uses this as initialData and skips the redundant
 * first client-side fetch.
 */
export function SSRInitialClimbsProvider({ initialClimbs, hasMore, children }: SSRInitialClimbsProviderProps) {
  const value = useMemo(
    () => (initialClimbs.length > 0 ? { climbs: initialClimbs, hasMore } : null),
    [initialClimbs, hasMore],
  );

  return (
    <SSRInitialClimbsContext.Provider value={value}>
      {children}
    </SSRInitialClimbsContext.Provider>
  );
}

/**
 * Returns SSR initial climbs data if available, or null if no provider is present
 * or if the SSR response was empty.
 */
export function useSSRInitialClimbs(): SSRInitialClimbsData | null {
  return useContext(SSRInitialClimbsContext);
}
