/**
 * Route groups a launch-time gate must NOT interrupt: a cold start that landed
 * on a join/share/session deep link, the auth flow, the board picker, or the
 * onboarding screen itself. On those the user has explicit intent elsewhere and
 * a gate would steal focus. The Climbs tab (the launcher's default landing) is
 * the only surface a gate pushes over.
 *
 * Shared rather than per-gate so the onboarding walkthrough and the QA tester
 * prompt cannot drift apart on what counts as "the user is busy".
 */
export const DEEP_LINK_SEGMENTS: ReadonlySet<string> = new Set([
  'join',
  'share-beta',
  'session',
  'auth',
  'onboarding',
  'boards',
]);
