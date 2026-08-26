// Crowdsourced-QA funnel event names. Mobile-only (no web build can surf an OTA
// branch), so they stay free-string constants rather than entries in
// @boardsesh/analytics' SHARED_EVENTS — same rule as the OTA-adoption events in
// `../ota-telemetry.ts`.
//
// The funnel these measure: prompted → picked (or skipped) → brief shown →
// verdict submitted. `QA_SURF_FAILED_EVENT` and `QA_PREVIEW_LEFT_EVENT` are the
// two ways a tester exits it without a verdict, and telling them apart is the
// point: a surf failure is our bug, leaving on purpose is not.

/** The pick list was presented on launch. Properties: `count`. */
export const QA_PREVIEW_PROMPTED_EVENT = 'QA Preview Prompted';

/** The tester dismissed the pick list without choosing a PR. */
export const QA_PREVIEW_SKIPPED_EVENT = 'QA Preview Skipped';

/** A PR was chosen from the pick list. Properties: `prNumber`, `risk`. */
export const QA_PREVIEW_PICKED_EVENT = 'QA Preview Picked';

/** The brief (what to test) was shown on the surfed bundle. Properties: `prNumber`. */
export const QA_BRIEF_SHOWN_EVENT = 'QA Brief Shown';

/** A verdict reached the backend. Properties: `prNumber`, `verdict`, `risk`. */
export const QA_VERDICT_SUBMITTED_EVENT = 'QA Verdict Submitted';

/**
 * A surf attempt threw. Properties: `prNumber` (null when heading back to
 * production), `reason`.
 */
export const QA_SURF_FAILED_EVENT = 'QA Surf Failed';

/** The tester left a preview without filing a verdict. Properties: `prNumber`. */
export const QA_PREVIEW_LEFT_EVENT = 'QA Preview Left';
