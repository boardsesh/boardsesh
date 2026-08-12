/**
 * The one expression the whole offline engine is gated on, on native.
 *
 * `!== false`, NOT `=== true`, on purpose: an unresolved flag (`undefined`)
 * means PostHog's `/flags` response never landed, and the users whose flags
 * never land are the ones who opened the app with no signal — precisely this
 * feature's audience. Reading `undefined` as OFF switched the offline engine
 * off for exactly the people it exists for (issue #4312).
 *
 * So the flag is a pure kill switch: only an explicit `false` — a disabled
 * flag, a 0% rollout, or a tester override — turns the engine off. Two
 * consequences worth stating out loud: the kill switch only reaches users who
 * can reach PostHog, and DELETING the flag would read as ON everywhere.
 * Disable it or set it to 0% instead; both resolve to an explicit `false`.
 *
 * Expo web replaces this module with the `.web` fork.
 */
export function isOfflineDownloadsEnabled(featureFlag: boolean | undefined): boolean {
  return featureFlag !== false;
}
