'use client';

import { useEffect } from 'react';
import { gymQrScanned, stripGymQrParams, type GymQrMedium } from '@boardsesh/analytics';
import { useConsent } from '@/app/components/consent/consent-provider';
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
 * It gates the event and nothing else — the URL cleanup is its own effect.
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
 *
 * The count waits for `granted`. Consent settles after the hydration commit
 * (the session and the region lookup are async), and `track()` drops an event
 * sent before then, so counting on mount lost nearly every cold scan. The scan
 * is marked reported only when it is sent.
 *
 * A scan whose page the climber left before consent settled is lost, and,
 * unlike `BoardQrLandingTracker`, coming back does not recover it. Deliberate:
 * this tracker is mounted only when the SERVER saw the QR pair, and the return
 * visit's URL no longer carries it, so there is nothing mounted to count it.
 * Matching the board tracker would mean mounting on every gym page and
 * remembering landings in the browser, for a scan lost only by someone who
 * leaves before consent settles soon after hydration. Not worth the change.
 */
export default function GymQrLandingTracker({ gymSlug, medium }: GymQrLandingTrackerProps) {
  const { granted } = useConsent();

  useEffect(() => {
    // Clean the URL unconditionally, consent or not. The dedupe below stops a
    // repeat landing from being counted twice, but a repeat landing still
    // arrives with `?src=qr&medium=…` in the address bar — gym A → B → back to
    // A — and that is exactly the link someone shares or bookmarks. Tying the
    // cleanup to the count left the params sitting there, defeating the reason
    // to strip them. replaceState (not router.replace) keeps it a URL rewrite
    // with no re-render and no server round-trip.
    //
    // One task later, like `useClaimParamStrip` and `BoardQrLandingTracker`: on
    // the hydration commit this effect runs before Next has patched
    // `history.replaceState`, and a native call then leaves the router's own URL
    // holding the pair, to be written back by its next history update.
    const stripTimer = setTimeout(() => {
      const cleanedSearch = stripGymQrParams(window.location.search);
      if (cleanedSearch !== window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
      }
    }, 0);
    return () => clearTimeout(stripTimer);
  }, [gymSlug, medium]);

  useEffect(() => {
    if (!granted) return;
    const scanKey = `${gymSlug}:${medium}`;
    if (reportedScans.has(scanKey)) return;
    reportedScans.add(scanKey);

    trackGymFunnelEvent(gymQrScanned({ medium, gymSlug }));
  }, [granted, gymSlug, medium]);

  return null;
}
