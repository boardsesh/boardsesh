'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useConsent } from './consent/consent-provider';
import { subscribeWebConsent } from '@/app/lib/consent';
import { syncAdPixels } from '@/app/lib/ad-pixels-browser';

/**
 * Keeps the Meta and Reddit pixels in step with consent and sends a page view
 * per page. Renders nothing. The scripts are injected from an effect, after
 * hydration and only once consent allows them, so they never block a render.
 * See docs/analytics-consent.md#ad-pixels.
 */
export default function AdPixelsClient() {
  const pathname = usePathname();
  const { granted, snapshot } = useConsent();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (pathname) syncAdPixels(pathname);
  }, [pathname, granted, snapshot.record]);

  // A withdrawal on another origin or tab changes the shared cookie without
  // always changing the values above; react to the consent store directly too.
  useEffect(
    () =>
      subscribeWebConsent(() => {
        if (pathnameRef.current) syncAdPixels(pathnameRef.current);
      }),
    [],
  );

  return null;
}
