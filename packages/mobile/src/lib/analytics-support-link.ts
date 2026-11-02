import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';
import type { SupportCadence, SupportLinkSurface } from './donation-links';

/**
 * Fired on the tap, before the browser opens, so a failed open still counts.
 * `cadence` is sent only by a surface that offers both ways of giving.
 */
export function trackSupportLinkTapped(surface: SupportLinkSurface, cadence?: SupportCadence): void {
  track(SHARED_EVENTS.SupportLinkTapped, cadence ? { surface, cadence } : { surface });
}
