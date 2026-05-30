// FeatureFlagsProvider — mirrors `packages/web/app/components/providers/feature-flags-provider.tsx`.
// Web sources flags from the Vercel Flags SDK; mobile has no equivalent today,
// so the provider accepts an optional `flags` prop (used by tests) and falls
// back to an empty bag. When real flags arrive we can either fetch them at
// boot or move the type into a shared package and converge with web.

import { createContext, useContext, type ReactNode } from 'react';

export type FeatureFlags = Record<string, never>;

const DEFAULT_FEATURE_FLAGS: FeatureFlags = {};

const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FEATURE_FLAGS);

export function FeatureFlagsProvider({
  flags = DEFAULT_FEATURE_FLAGS,
  children,
}: {
  flags?: FeatureFlags;
  children: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
  return useFeatureFlags()[key];
}
