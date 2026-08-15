'use client';

import { useEffect } from 'react';
import { gymQrScanned, stripGymQrParams, type GymQrMedium } from '@boardsesh/analytics';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

type GymQrLandingTrackerProps = {
  gymSlug: string;
  medium: GymQrMedium;
};

/**
 * Fires exactly once per document, keyed on the landing it reported. React
 * StrictMode mounts, unmounts and remounts every effect in development, and a
 * client-side navigation back to the same gym would otherwise re-attribute the
 * visit to the poster on the wall. Module scope (not a ref) because the second
 * StrictMode pass runs against a fresh component instance.
 */
const reportedScans = new Set<string>();

/**
 * Renders nothing. Mounted by the gym page only when `parseGymQrLanding`
 * recognises the `?src=qr&medium=…` pair a printed code carries.
 *
 * The parsed medium and the slug arrive as PROPS rather than being read here
 * with `useSearchParams`: that hook opts the whole subtree out of static
 * rendering and demands a Suspense boundary, which is a large price for a
 * component whose entire output is `null`. The server has already parsed the
 * params anyway.
 */
export default function GymQrLandingTracker({ gymSlug, medium }: GymQrLandingTrackerProps) {
  useEffect(() => {
    const scanKey = `${gymSlug}:${medium}`;
    if (reportedScans.has(scanKey)) return;
    reportedScans.add(scanKey);

    trackGymFunnelEvent(gymQrScanned({ medium, gymSlug }));

    // Drop the attribution params once they've been counted, so a link the
    // climber shares or bookmarks doesn't credit the poster for someone else's
    // visit. replaceState (not router.replace) keeps this a URL rewrite with no
    // re-render and no server round-trip.
    const cleanedSearch = stripGymQrParams(window.location.search);
    if (cleanedSearch !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
    }
  }, [gymSlug, medium]);

  return null;
}
