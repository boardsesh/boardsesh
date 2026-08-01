'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { onCLS, onFCP, onINP, onLCP, type Metric } from 'web-vitals';
import { capturePosthog, pageview } from '@/app/lib/analytics';
import { analyticsPathname, isAdminAnalyticsUrl, isEmbedAnalyticsUrl } from '@/app/lib/analytics-paths';

// PostHog's Web Vitals dashboard widget surfaces LCP, CLS, FCP, INP and
// expects a single batched `$web_vitals` event per page with metric-prefixed
// properties (`$web_vitals_<NAME>_value`, `$web_vitals_<NAME>_rating`, ...).
// posthog-js-lite has no built-in web vitals capture, so we mirror the shape
// of the official posthog-js extension. The `_event` object posthog-js also
// emits is skipped — our analytics helper only forwards primitive property
// values, and the dashboard renders from `_value` + `_rating`.
const ALLOWED_METRICS = ['LCP', 'CLS', 'FCP', 'INP'] as const;
const FLUSH_DELAY_MS = 5000;

type VitalsBuffer = {
  metrics: Map<string, Metric>;
  pageUrl: string | null;
  timerId: ReturnType<typeof setTimeout> | null;
};

function flushVitalsBuffer(buffer: VitalsBuffer): void {
  if (buffer.timerId !== null) {
    clearTimeout(buffer.timerId);
    buffer.timerId = null;
  }
  if (buffer.metrics.size === 0) return;

  const pageUrl = buffer.pageUrl;
  const metrics = buffer.metrics;
  buffer.metrics = new Map();
  buffer.pageUrl = null;

  // No web-vitals off /admin, and none off /embed/** — embeds run inside
  // third-party sites with no consent surface (see isEmbedAnalyticsUrl).
  if (!pageUrl || isAdminAnalyticsUrl(pageUrl) || isEmbedAnalyticsUrl(pageUrl)) return;

  const props: Record<string, string | number | boolean | null> = {
    $current_url: analyticsPathname(pageUrl),
  };
  for (const [name, metric] of metrics) {
    props[`$web_vitals_${name}_value`] = metric.value;
    props[`$web_vitals_${name}_rating`] = metric.rating;
    props[`$web_vitals_${name}_delta`] = metric.delta;
    props[`$web_vitals_${name}_id`] = metric.id;
    props[`$web_vitals_${name}_navigation_type`] = metric.navigationType;
  }

  capturePosthog('$web_vitals', props);
}

export default function AnalyticsClient() {
  const pathname = usePathname();
  const vitalsRegistered = useRef(false);
  const bufferRef = useRef<VitalsBuffer>({ metrics: new Map(), pageUrl: null, timerId: null });

  useEffect(() => {
    // web-vitals' on* callbacks attach document-lifetime listeners — guard so
    // StrictMode's effect re-run can't double-register them and double-count
    // each metric.
    if (vitalsRegistered.current) return;
    // /embed/** widgets are full-document loads with no in-app navigation
    // away, so skipping registration at mount disables web-vitals capture
    // there entirely (GDPR: no consent surface inside a third-party iframe —
    // see isEmbedAnalyticsUrl). The flush-time check above is the backstop.
    if (isEmbedAnalyticsUrl(window.location.href)) return;
    vitalsRegistered.current = true;

    const reportVital = (metric: Metric): void => {
      const buffer = bufferRef.current;
      if (buffer.metrics.size === 0) {
        buffer.pageUrl = typeof window === 'undefined' ? null : window.location.href;
        buffer.timerId = setTimeout(() => flushVitalsBuffer(buffer), FLUSH_DELAY_MS);
      }
      buffer.metrics.set(metric.name, metric);
      if (buffer.metrics.size >= ALLOWED_METRICS.length) flushVitalsBuffer(buffer);
    };

    onCLS(reportVital);
    onFCP(reportVital);
    onINP(reportVital);
    onLCP(reportVital);
  }, []);

  // Separate effect so StrictMode's cleanup-and-remount in dev re-attaches
  // the pagehide listener instead of leaving it removed.
  useEffect(() => {
    const onPageHide = (): void => flushVitalsBuffer(bufferRef.current);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  useEffect(() => {
    if (!pathname) return;
    if (isAdminAnalyticsUrl(pathname)) return;
    // No PostHog pageviews off /embed/** (third-party iframe, no consent
    // surface — see isEmbedAnalyticsUrl). Kiosk keeps first-party telemetry.
    if (isEmbedAnalyticsUrl(pathname)) return;

    // Flush metrics buffered against the previous URL before recording the new
    // pageview, so each `$web_vitals` event stays bound to the page it
    // measured.
    const buffer = bufferRef.current;
    if (buffer.metrics.size > 0 && buffer.pageUrl && analyticsPathname(buffer.pageUrl) !== pathname) {
      flushVitalsBuffer(buffer);
    }

    pageview(pathname);
  }, [pathname]);

  return null;
}
