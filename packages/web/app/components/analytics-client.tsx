'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import { pageview, track } from '@/app/lib/analytics';

function reportVital(metric: Metric): void {
  track('$web_vitals', {
    metric: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
  });
}

export default function AnalyticsClient() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const vitalsRegistered = useRef(false);

  useEffect(() => {
    if (vitalsRegistered.current) return;
    vitalsRegistered.current = true;
    onCLS(reportVital);
    onFCP(reportVital);
    onINP(reportVital);
    onLCP(reportVital);
    onTTFB(reportVital);
  }, []);

  useEffect(() => {
    if (!pathname) return;
    const search = searchParams?.toString();
    const url = search ? `${pathname}?${search}` : pathname;
    pageview(url);
  }, [pathname, searchParams]);

  return null;
}
