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
 * A SETTLED authentication answer in the contract's vocabulary.
 *
 * Takes a boolean, not NextAuth's `useSession().status`, and that is the whole
 * point. `SessionProviderWrapper` mounts `<SessionProvider>` with no `session`
 * prop, so next-auth starts every page load at `status: 'loading'` and settles
 * only after a round-trip to `/api/auth/session`. A server-rendered page paints
 * and hydrates before that lands, so a click that beats it — a QR poster
 * scanned on a phone is exactly that case — would read `loading` and report a
 * signed-in climber as `signed-out`.
 *
 * Callers must pass a value that has already settled: a server-read auth token,
 * or `useWsAuthToken().isAuthenticated`, whose own query is gated on
 * `status !== 'loading'` — so holding a gym fetched through it means the
 * session resolved. `GymClaimViewerState` deliberately has no `loading` member:
 * a third bucket would encode the hydration race as vocabulary instead of
 * keeping it out of the data.
 */
export function viewerStateFrom(isAuthenticated: boolean): GymClaimViewerState {
  return isAuthenticated ? 'signed-in' : 'signed-out';
}
