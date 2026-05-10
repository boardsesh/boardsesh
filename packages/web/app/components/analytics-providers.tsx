'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

function excludeAdmin(event: { url: string }) {
  return event.url.includes('/admin') ? null : event;
}

export function AnalyticsProviders() {
  return (
    <>
      <Analytics beforeSend={excludeAdmin} />
      <SpeedInsights beforeSend={excludeAdmin} />
    </>
  );
}
