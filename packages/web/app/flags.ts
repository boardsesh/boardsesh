// A flat bag of runtime feature flags. `Record<string, boolean | undefined>` (rather than
// the prior `Record<string, never>`, which made `useFeatureFlag` resolve to
// `never` and was therefore unusable) so consumers can call
// `useFeatureFlag('some-flag')` for any string key and get a `boolean | undefined`
// back. The live value is `undefined` (falsy) until a flag source is wired up, so
// every flag is OFF by default — matching the mobile FeatureFlagsProvider placeholder.
export type FeatureFlags = Record<string, boolean | undefined>;

export const EMPTY_FEATURE_FLAGS: FeatureFlags = {};

// Single source of truth for the flag key, imported by the banner component so a
// rename can't silently desync the two. Nudges legacy Capacitor-app users to
// install the RN app.
export const CAPACITOR_UPDATE_BANNER_FLAG = 'capacitor-update-banner';

// Keys read from PostHog by FeatureFlagsProvider. Each must have a matching
// PostHog feature flag; values stay `undefined` (OFF) until that flag resolves.
export const FEATURE_FLAG_KEYS = [CAPACITOR_UPDATE_BANNER_FLAG] as const;

// Vercel's flags discovery endpoint expects an allFlags export.
export const allFlags: Array<{ key: string }> = FEATURE_FLAG_KEYS.map((key) => ({ key }));
