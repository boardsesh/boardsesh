'use client';

import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { EMPTY_FEATURE_FLAGS, FEATURE_FLAG_KEYS, type FeatureFlags } from '@/app/flags';
import { readPosthogFeatureFlags, subscribePosthogFeatureFlags } from '@/app/lib/analytics';

const FeatureFlagsContext = createContext<FeatureFlags>(EMPTY_FEATURE_FLAGS);

export function FeatureFlagsProvider({ flags, children }: { flags: FeatureFlags; children: ReactNode }) {
  const [posthogFlags, setPosthogFlags] = useState<FeatureFlags>(EMPTY_FEATURE_FLAGS);

  useEffect(() => {
    let mounted = true;
    const refreshFlags = () => {
      const nextFlags = readPosthogFeatureFlags(FEATURE_FLAG_KEYS);
      if (!mounted) return;
      setPosthogFlags((previousFlags) => (featureFlagsEqual(previousFlags, nextFlags) ? previousFlags : nextFlags));
    };

    refreshFlags();
    const unsubscribe = subscribePosthogFeatureFlags(refreshFlags);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<FeatureFlags>(() => {
    if (posthogFlags === EMPTY_FEATURE_FLAGS && flags === EMPTY_FEATURE_FLAGS) {
      return EMPTY_FEATURE_FLAGS;
    }
    return { ...posthogFlags, ...flags };
  }, [posthogFlags, flags]);

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
  return useFeatureFlags()[key];
}

function featureFlagsEqual(leftFlags: FeatureFlags, rightFlags: FeatureFlags): boolean {
  const leftKeys = Object.keys(leftFlags);
  const rightKeys = Object.keys(rightFlags);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => leftFlags[key] === rightFlags[key]);
}
