import type { AnalyticsPropertyValue, GymClaimViewerState, GymFunnelEventName } from '@boardsesh/analytics';
import { track } from './analytics';

/**
 * The one bridge between the gym funnel event contract
 * (`@boardsesh/analytics`'s `gym-funnel` module) and web's `track()`.
 *
 * Every gym-funnel call site goes through here rather than calling `track()`
 * with a name and a hand-built object: the contract's builders return the name
 * and its properties TOGETHER, and this signature is what keeps them together
 * all the way to the wire. A call site physically cannot pair one event's props
 * with another event's name.
 *
 * Flat file, not `app/lib/analytics/gym-funnel.ts`: `app/lib/analytics.ts`
 * already exists, and a sibling `app/lib/analytics/` directory would make the
 * `@/app/lib/analytics` specifier resolve to whichever of the two the bundler
 * picked first.
 */
export function trackGymFunnelEvent(event: {
  name: GymFunnelEventName;
  properties: Record<string, AnalyticsPropertyValue>;
}): void {
  track(event.name, event.properties);
}

/**
 * NextAuth's `useSession().status` in the contract's vocabulary.
 *
 * `loading` maps to `signed-out` deliberately. The alternative is a third
 * bucket that means "the click happened before the session resolved", which is
 * a fact about our hydration timing rather than about the climber, and it would
 * split the one breakdown this property exists for. A signed-in climber whose
 * session is still resolving is the same funnel step as a signed-out one: both
 * are about to meet the auth wall.
 */
export function viewerStateFromSessionStatus(
  status: 'authenticated' | 'unauthenticated' | 'loading',
): GymClaimViewerState {
  return status === 'authenticated' ? 'signed-in' : 'signed-out';
}
