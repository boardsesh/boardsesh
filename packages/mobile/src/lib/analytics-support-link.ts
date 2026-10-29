import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';
import type { SupportLinkSurface } from './donation-links';

/** Fired on the tap, before the browser opens, so a failed open still counts. */
export function trackSupportLinkTapped(surface: SupportLinkSurface): void {
  track(SHARED_EVENTS.SupportLinkTapped, { surface });
}
