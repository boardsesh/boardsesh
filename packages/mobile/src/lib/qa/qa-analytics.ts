// Crowdsourced-QA funnel event names. Mobile-only (no web build can surf an OTA
// branch), so they stay free-string constants rather than entries in
// @boardsesh/analytics' SHARED_EVENTS — same rule as the OTA-adoption events in
// `../ota-telemetry.ts`.
//
// The funnel these measure: prompted → picked (or skipped) → brief shown →
// verdict submitted. `QA_SURF_FAILED_EVENT` and `QA_PREVIEW_LEFT_EVENT` are the
// two ways a tester exits it without a verdict, and telling them apart is the
// point: a surf failure is our bug, leaving on purpose is not.

/**
 * The `origin` route param the launch gate puts on `/qa/pick`, and the only
 * thing that arms `QA_PREVIEW_SKIPPED_EVENT`.
 *
 * The pick list is reachable three ways — the launch prompt, the user drawer's
 * "Test a PR preview" row, and the dev row on More — but only the first is the
 * prompt whose skips the funnel is about. Without this marker, a tester opening
 * the picker from the drawer and closing it again counted as a skipped prompt
 * that was never shown, and prompted → picked/skipped stopped adding up.
 */
export const LAUNCH_ORIGIN = 'launch';

/** The pick list was presented on launch. Properties: `count`. */
export const QA_PREVIEW_PROMPTED_EVENT = 'QA Preview Prompted';

/**
 * The tester dismissed the LAUNCH prompt without choosing a PR. Never fired for
 * the picker opened by hand — see `LAUNCH_ORIGIN`.
 */
export const QA_PREVIEW_SKIPPED_EVENT = 'QA Preview Skipped';

/**
 * A PR was chosen. Properties: `prNumber`, `risk`, `source`.
 *
 * `source` is `'list'` for a tapped row and `'search'` for the "try it anyway"
 * affordance behind a no-match search. Both are picks and both belong in the same
 * event: a forced surf still runs a bundle and still ends in a brief and a verdict,
 * so splitting it out would fork the funnel this file exists to keep whole. `risk`
 * is null for a `'search'` pick — an unlisted PR has no metadata on the device.
 */
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

/**
 * The `reason` property of `QA_SURF_FAILED_EVENT`. The thrown message is the
 * whole triage value here — "Branch surfing is unavailable on this build" and
 * "Could not reach the update server (502)" are entirely different bugs — so it
 * is carried verbatim, capped so one pathological error can't bloat the event.
 */
export function surfFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

/** The tester left a preview without filing a verdict. Properties: `prNumber`. */
export const QA_PREVIEW_LEFT_EVENT = 'QA Preview Left';

/**
 * A forced surf found nothing: a re-read of the branch list still did not offer that
 * `pr-<n>` for this build. Properties: `prNumber`, `refetchFailed`.
 *
 * The counterweight to a `'search'` pick. Picks minus misses is the whole argument
 * for whether the escape hatch earns its place, and `refetchFailed` separates "the
 * PR really has no preview for this build" from "we could not re-check the list".
 */
export const QA_UNLISTED_SURF_MISSED_EVENT = 'QA Unlisted Surf Missed';
