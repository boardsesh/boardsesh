// A flat bag of runtime feature flags. `Record<string, boolean | undefined>` (rather than
// the prior `Record<string, never>`, which made `useFeatureFlag` resolve to
// `never` and was therefore unusable) so consumers can call
// `useFeatureFlag('some-flag')` for any string key and get a `boolean | undefined`
// back. The live value is `undefined` (falsy) until a flag source is wired up, so
// every flag is OFF by default — matching the mobile FeatureFlagsProvider placeholder.
export type FeatureFlags = Record<string, boolean | undefined>;

export const EMPTY_FEATURE_FLAGS: FeatureFlags = {};

// Gates the "Boardsesh grade" section in the climb detail / play drawer. OFF
// until the nightly data-science grading job has enough coverage to surface.
export const BOARDSESH_GRADE_FLAG = 'boardsesh-grade';

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
export const FEATURE_FLAG_KEYS = [BOARDSESH_GRADE_FLAG, GYM_KIOSK_FLAG, MOONBOARD_WIDE_ANGLES_FLAG] as const;

// Gates `/build-plans` — the paid CNC build-pack configurator, the orders
// pages, and the footer link into them. Server-resolved rather than client,
// because this gate has to make an unreachable surface 404 rather than hide a
// button: the manufacturing licence ships marked DRAFT until an Australian IP
// lawyer has reviewed it and the Kilter-derived engrave layer, so the pages
// must not be reachable — or indexable — before then.
//
// Resolved with `allowAnonymous: true`. Build plans are bought by people who
// have never signed in, so a gate that only evaluates for a session would keep
// the page signed-in-only however the dashboard is configured.
// `FEATURE_FLAG_OVERRIDES=cnc-packs` is how you reach it locally.
export const CNC_PACKS_FLAG = 'cnc-packs';

// Keys resolved server-side by `getServerFeatureFlag`, which gate whether a
// route renders at all. `/gyms` launched unconditionally and emptied this list;
// `/build-plans` is its current occupant. That is a different gate from the
// client keys above (see docs/feature-flags.md), and these keys are
// deliberately kept out of FEATURE_FLAG_KEYS: the browser provider would fetch
// a flag no client component reads.
export const SERVER_FEATURE_FLAG_KEYS = [CNC_PACKS_FLAG] as const;
