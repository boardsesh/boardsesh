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
 * flag, a 0% rollout, or a tester override — turns the engine off. Three
 * consequences worth stating out loud:
 *
 * 1. The kill switch only reaches users who can reach PostHog. A permanently
 *    offline device keeps the engine whatever the flag says.
 * 2. DELETING the flag reads as ON everywhere. Disable it or set it to 0%
 *    instead; both resolve to an explicit `false`.
 * 3. The switch lands a beat late, even for a reachable device. Every launch
 *    starts with an empty flag bag, so this returns `true` on the first render
 *    for everyone; a killed device only flips off once PostHog answers. If the
 *    scheduler's mount effect wins that race, `startSyncScheduler` has already
 *    fired its immediate cycle (its `stop()` does not abort one in flight), so
 *    a killed device can still run one drain+pull per launch. That matters when
 *    the switch is being thrown at a crash — it is a kill for the session, not
 *    for the launch.
 *
 * Expo web replaces this module with the `.web` fork.
 */
export function isOfflineDownloadsEnabled(featureFlag: boolean | undefined): boolean {
  return featureFlag !== false;
}
