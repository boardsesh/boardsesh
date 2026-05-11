'use client';

import React from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { isAdminAnalyticsUrl } from '@/app/lib/analytics-paths';

// Function props (the beforeSend filter that drops /admin pageviews) cannot
// be passed from a Server Component (RootLayout) to a Client Component
// because React Flight tries to JSON-serialize them across the boundary,
// throwing: "Functions cannot be passed directly to Client Components
// unless you explicitly expose it by marking it with 'use server'."
//
// Regression fixed in #2043 / re-guarded in #2061 (Sentry BOARDSESH-65).
// Keep `dropAdminEvents` module-scoped — never re-shape these to accept a
// `beforeSend` from the caller, or the home route SSR will break for every
// visitor on the next deploy. The `enabled` prop below is a plain boolean,
// which IS RSC-serializable, so it does not violate this constraint.
const dropAdminEvents = <Event extends { url: string }>(event: Event): Event | null => {
  return isAdminAnalyticsUrl(event.url) ? null : event;
};

type TelemetryWrapperProps = {
  /** When `false`, the wrapper renders nothing — used to honour the
   * analytics consent decision read in the root layout. Defaults to `true`. */
  enabled?: boolean;
};

export function VercelAnalytics({ enabled = true }: TelemetryWrapperProps = {}) {
  if (!enabled) return null;
  return <Analytics beforeSend={dropAdminEvents} />;
}

export function VercelSpeedInsights({ enabled = true }: TelemetryWrapperProps = {}) {
  if (!enabled) return null;
  return <SpeedInsights beforeSend={dropAdminEvents} />;
}
