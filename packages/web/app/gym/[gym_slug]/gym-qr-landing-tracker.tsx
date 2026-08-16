'use client';

import { useEffect } from 'react';
import { gymQrScanned, stripGymQrParams, type GymQrMedium } from '@boardsesh/analytics';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

type GymQrLandingTrackerProps = {
  gymSlug: string;
  medium: GymQrMedium;
};

/**
 * Which landings have already been REPORTED. React StrictMode mounts, unmounts
 * and remounts every effect in development, and a client-side navigation back
 * to the same gym would otherwise re-attribute the visit to the poster on the
 * wall. Module scope (not a ref) because the second StrictMode pass runs
 * against a fresh component instance.
 *
 * It gates the event and nothing else — see the URL cleanup below.
 */
const reportedScans = new Set<string>();

/** Test-only: the dedupe Set outlives every unmount, so a suite reusing a slug would silently pass. */
export function __resetReportedScansForTests(): void {
  reportedScans.clear();
}

/**
 * Renders nothing. Mounted by the gym page only when `parseGymQrLanding`
 * recognises the `?src=qr&medium=…` pair a printed code carries.
 *
 * The parsed medium and the slug arrive as PROPS rather than being read here
 * with `useSearchParams`, which would force a Suspense boundary around a
 * component whose entire output is `null`. (It would not cost static rendering —
 * this route already opts out by awaiting `cookies()` via `getServerAuthToken`.)
 * The server has parsed the params anyway.
 */
export default function GymQrLandingTracker({ gymSlug, medium }: GymQrLandingTrackerProps) {
  useEffect(() => {
    // Clean the URL FIRST, and unconditionally. The dedupe below stops a repeat
    // landing from being counted twice, but a repeat landing still arrives with
    // `?src=qr&medium=…` in the address bar — gym A → B → back to A — and that
    // is exactly the link someone shares or bookmarks. Returning early above
    // this left the params sitting there, defeating the reason to strip them.
    // replaceState (not router.replace) keeps it a URL rewrite with no
    // re-render and no server round-trip.
    const cleanedSearch = stripGymQrParams(window.location.search);
    if (cleanedSearch !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
    }

    const scanKey = `${gymSlug}:${medium}`;
    if (reportedScans.has(scanKey)) return;
    reportedScans.add(scanKey);

    trackGymFunnelEvent(gymQrScanned({ medium, gymSlug }));
  }, [gymSlug, medium]);

  return null;
}
