import { PARTNER_DEVELOPER_CONSOLE_FLAG } from '@boardsesh/auth-protocol/partner-oauth';

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

// Gates the developer console at /developers/apps, where a developer registers
// partner OAuth apps (docs/integrations/integration-platform.md, milestone 1.6). Server-side
// and failing closed: with the flag off, or PostHog unreachable, the route is a
// 404. The backend asks the same flag again before every console operation
// (after PARTNER_OAUTH_MODE), so the key lives in @boardsesh/auth-protocol and
// the page and the operations cannot disagree on who is invited.
export const DEVELOPER_CONSOLE_FLAG = PARTNER_DEVELOPER_CONSOLE_FLAG;

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

// Report a problem on boards and gyms (docs/product/directory-reports.md). The
// backend's switch for the whole service: it gates `reportBoard` / `reportGym`
// and every report notice. www reads the same answer, for the same fixed id
// (`DIRECTORY_REPORTS_FLAG_DISTINCT_ID`), to decide whether the entry points
// render at all, so a page never offers a report the server would refuse.
// Fails closed like every server flag. See `isDirectoryReportsEnabled`.
export const DIRECTORY_REPORTS_FLAG = 'directory-reports';

/** The fixed id PostHog evaluates `directory-reports` for, on the backend and here. Not a person. */
export const DIRECTORY_REPORTS_FLAG_DISTINCT_ID = 'system:directory-reports';

// The setup fields on "Set up wrong" (docs/product/directory-reports.md, "The
// `directory-setup-suggestions` flag"). The backend's switch for a suggestion
// changing a board at a gym nobody runs; www reads the same answer, for the same
// fixed id, to decide whether the report dialog shows the fields. Off, the
// dialog is the note-only one. Fails closed like every server flag. See
// `isDirectorySetupSuggestionsEnabled`.
export const DIRECTORY_SETUP_SUGGESTIONS_FLAG = 'directory-setup-suggestions';

/** The fixed id PostHog evaluates `directory-setup-suggestions` for, on the backend and here. Not a person. */
export const DIRECTORY_SETUP_SUGGESTIONS_FLAG_DISTINCT_ID = 'system:directory-setup-suggestions';

// Keys resolved server-side by `getServerFeatureFlag`, which gate whether a
// route renders at all — a different gate from the client keys above (see
// docs/operations/feature-flags.md). Deliberately kept out of FEATURE_FLAG_KEYS: the
// browser provider would fetch a flag no client component reads.
export const SERVER_FEATURE_FLAG_KEYS = [
  DEVELOPER_CONSOLE_FLAG,
  CNC_PACKS_FLAG,
  DIRECTORY_REPORTS_FLAG,
  DIRECTORY_SETUP_SUGGESTIONS_FLAG,
] as const;
