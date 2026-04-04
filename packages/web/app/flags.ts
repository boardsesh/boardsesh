export type FeatureFlags = Record<string, never>;

export const EMPTY_FEATURE_FLAGS: FeatureFlags = {};

// Vercel's flags discovery endpoint still expects an allFlags export even when
// there are no active runtime flags configured.
export const allFlags: Array<{ key: string }> = [];
