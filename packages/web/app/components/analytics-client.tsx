'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import { capturePosthog, pageview } from '@/app/lib/analytics';
import { isAdminAnalyticsUrl } from '@/app/lib/analytics-paths';
import { attachLifecycleListeners, startPageview } from '@/app/lib/analytics-page-tracker';

export default function AnalyticsClient() {
  const pathname = usePathname();
  const pathnameRef = useRef<string | null>(null);
  const vitalsRegistered = useRef(false);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (vitalsRegistered.current) return;
    vitalsRegistered.current = true;

    const reportVital = (metric: Metric): void => {
      const currentPath = pathnameRef.current;
      if (currentPath && isAdminAnalyticsUrl(currentPath)) return;

      capturePosthog('$web_vitals', {
        metric: metric.name,
        value: metric.value,
        rating: metric.rating,
        delta: metric.delta,
        id: metric.id,
        navigationType: metric.navigationType ?? null,
      });
    };

    onCLS(reportVital);
    onFCP(reportVital);
    onINP(reportVital);
    onLCP(reportVital);
    onTTFB(reportVital);
  }, []);

  useEffect(() => {
    attachLifecycleListeners();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    const prevPageviewProperties = startPageview(pathname);
    if (isAdminAnalyticsUrl(pathname)) return;
    pageview(pathname, prevPageviewProperties ?? undefined);
  }, [pathname]);

  return null;
}
