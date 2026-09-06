import type { AnalyticsPropertyValue, CncFunnelEventName } from '@boardsesh/analytics';
import { track } from './analytics';

/**
 * The one bridge between the CNC build-pack funnel contract
 * (`@boardsesh/analytics`'s `cnc-funnel` module) and web's `track()`.
 *
 * Mirrors `trackGymFunnelEvent` exactly, and for the same reason: the contract's
 * builders return the name and its properties TOGETHER, and this signature is
 * what keeps them together all the way to the wire. A call site physically
 * cannot pair one event's props with another event's name.
 *
 * Flat file, not `app/lib/analytics/cnc-funnel.ts`: `app/lib/analytics.ts`
 * already exists, and a sibling `app/lib/analytics/` directory would make the
 * `@/app/lib/analytics` specifier resolve to whichever of the two the bundler
 * picked first.
 */
export function trackCncFunnelEvent(event: {
  name: CncFunnelEventName;
  properties: Record<string, AnalyticsPropertyValue>;
}): void {
  track(event.name, event.properties);
}
