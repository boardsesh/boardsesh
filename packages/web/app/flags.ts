// A flat bag of runtime feature flags. `Record<string, boolean | undefined>` (rather than
// the prior `Record<string, never>`, which made `useFeatureFlag` resolve to
// `never` and was therefore unusable) so consumers can call
// `useFeatureFlag('some-flag')` for any string key and get a `boolean | undefined`
// back. The live value is `undefined` (falsy) until a flag source is wired up, so
// every flag is OFF by default — matching the mobile FeatureFlagsProvider placeholder.
export type FeatureFlags = Record<string, boolean | undefined>;

export const EMPTY_FEATURE_FLAGS: FeatureFlags = {};

// Gates the gym-kiosk MANAGE entry points (gym manage tab, kiosk editor —
// landing in a later PR). The public `/kiosk/{gym-slug}` TV pages themselves
// ship flagless: a 24/7 TV can't be expected to resolve PostHog flags, and the
// page is only reachable via a URL the gym owner configured on purpose.
export const GYM_KIOSK_FLAG = 'gym-kiosk';

// Gates offering MoonBoard's full 0-70° angle range in angle pickers (angle
// drawer, board selector, playlist generator, log-ascent form, propose-change
// form, create-climb form). OFF keeps every picker limited to MOONBOARD_ANGLES
// (25°/40°, the two angles Moon Climbing's own catalog grades) — see
// MOONBOARD_WIDE_ANGLES in @boardsesh/board-config. Nothing server-side
// enforces this restriction (angle is a plain 0-90 bounded int everywhere it's
// validated), so this is purely a UI rollout control, same as every other flag
// here — matching the documented "flags gate the UI entry point only" pattern.
export const MOONBOARD_WIDE_ANGLES_FLAG = 'moonboard-wide-angles';

// Keys read from PostHog by FeatureFlagsProvider. Each must have a matching
// PostHog feature flag; values stay `undefined` (OFF) until that flag resolves.
export const FEATURE_FLAG_KEYS = [GYM_KIOSK_FLAG, MOONBOARD_WIDE_ANGLES_FLAG] as const;

// Keys resolved server-side by `getServerFeatureFlag`, which gate whether a
// route renders at all. Empty since `/gyms` launched unconditionally; the
// machinery stays because that is a different gate from the client keys above
// (see docs/feature-flags.md). Deliberately kept out of FEATURE_FLAG_KEYS: the
// browser provider would fetch a flag no client component reads.
export const SERVER_FEATURE_FLAG_KEYS = [] as const;
