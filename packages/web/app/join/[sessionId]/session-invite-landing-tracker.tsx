'use client';

import { useEffect } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { trackBeforeNavigation } from '@/app/lib/analytics';
import type { SessionInvitePageState } from './session-invite';

type SessionInviteLandingTrackerProps = {
  /**
   * The session the invite names. Left out when the link names no session:
   * that id is whatever sat in the URL (a typo, a crawler's guess), and it has
   * no business in analytics. Same rule as the store link's session id.
   */
  sessionId?: string;
  state: SessionInvitePageState;
  hasHost: boolean;
  hasGym: boolean;
};

/**
 * Landings already reported, keyed by the page path. React StrictMode mounts every effect twice in
 * development against a fresh component instance, so a ref would not hold;
 * module scope does. Same arrangement as `GymQrLandingTracker`.
 */
const reportedLandings = new Set<string>();

/** Test-only: the Set outlives every unmount. */
export function __resetReportedLandingsForTests(): void {
  reportedLandings.clear();
}

/**
 * Renders nothing; counts one `Session Invite Page Viewed` per landing.
 *
 * Sent with `trackBeforeNavigation`, which flushes the event straight away
 * instead of leaving it in the batch queue. People leave this page fast and to
 * another origin: a store button, or the phone handing the link to the app. The
 * queue flushes every 10 seconds and has no unload transport, which is the
 * likely reason the old redirect-on-mount page recorded 9 pageviews in 28 days
 * against about 75 joiners.
 */
export default function SessionInviteLandingTracker({
  sessionId,
  state,
  hasHost,
  hasGym,
}: SessionInviteLandingTrackerProps) {
  useEffect(() => {
    const landingKey = window.location.pathname;
    if (reportedLandings.has(landingKey)) return;
    reportedLandings.add(landingKey);
    void trackBeforeNavigation(SHARED_EVENTS.SessionInvitePageViewed, {
      ...(sessionId ? { sessionId } : {}),
      state,
      hasHost,
      hasGym,
    });
  }, [sessionId, state, hasHost, hasGym]);

  return null;
}
