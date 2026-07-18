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

// Gates the "Pair a Garmin watch" settings UI. OFF until the Connect IQ watch
// app is live (nothing to pair to before then). Imported by WatchPairingSection.
export const GARMIN_WATCH_FLAG = 'garmin-watch';

// Gates the "Boardsesh grade" section in the climb detail / play drawer. OFF
// until the nightly data-science grading job has enough coverage to surface.
export const BOARDSESH_GRADE_FLAG = 'boardsesh-grade';

// Gates the gym-kiosk MANAGE entry points (gym manage tab, kiosk editor —
// landing in a later PR). The public `/kiosk/{gym-slug}` TV pages themselves
// ship flagless: a 24/7 TV can't be expected to resolve PostHog flags, and the
// page is only reachable via a URL the gym owner configured on purpose.
export const GYM_KIOSK_FLAG = 'gym-kiosk';

// Keys read from PostHog by FeatureFlagsProvider. Each must have a matching
// PostHog feature flag; values stay `undefined` (OFF) until that flag resolves.
export const FEATURE_FLAG_KEYS = [
  CAPACITOR_UPDATE_BANNER_FLAG,
  'kilter-oauth-linking',
  GARMIN_WATCH_FLAG,
  BOARDSESH_GRADE_FLAG,
  GYM_KIOSK_FLAG,
] as const;

// Vercel's flags discovery endpoint expects an allFlags export.
export const allFlags: Array<{ key: string }> = FEATURE_FLAG_KEYS.map((key) => ({ key }));
