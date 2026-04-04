'use client';

import { createContext, useContext, ReactNode } from 'react';
import { EMPTY_FEATURE_FLAGS, type FeatureFlags } from '@/app/flags';

const FeatureFlagsContext = createContext<FeatureFlags>(EMPTY_FEATURE_FLAGS);

export function FeatureFlagsProvider({ flags, children }: { flags: FeatureFlags; children: ReactNode }) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
  return useFeatureFlags()[key];
}
