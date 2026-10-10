import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import AnalyticsClient from '../analytics-client';
import { __resetSessionInboundCampaignForTests, getSessionInboundCampaign } from '@/app/lib/inbound-campaign';

type VitalMetric = {
  name: string;
  value: number;
  rating: string;
  delta: number;
  id: string;
  navigationType: string | null;
};

const mocks = vi.hoisted(() => ({
  capturePosthog: vi.fn(),
  pageview: vi.fn(),
  track: vi.fn(),
  vitalCallbacks: [] as Array<(metric: VitalMetric) => void>,
  granted: true,
}));
let pathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('@/app/lib/analytics', () => ({
  capturePosthog: mocks.capturePosthog,
  pageview: mocks.pageview,
  track: mocks.track,
}));

vi.mock('web-vitals', () => ({
  onCLS: vi.fn((callback) => mocks.vitalCallbacks.push(callback)),
  onFCP: vi.fn((callback) => mocks.vitalCallbacks.push(callback)),
  onINP: vi.fn((callback) => mocks.vitalCallbacks.push(callback)),
  onLCP: vi.fn((callback) => mocks.vitalCallbacks.push(callback)),
}));

describe('AnalyticsClient', () => {
  beforeEach(() => {
    pathname = '/';
    mocks.granted = true;
    __resetSessionInboundCampaignForTests();
    window.history.replaceState(null, '', '/');
    mocks.capturePosthog.mockClear();
    mocks.pageview.mockClear();
    mocks.track.mockClear();
    mocks.vitalCallbacks.length = 0;
    vi.useRealTimers();
  });

  it('keeps landing tags in memory when consent follows navigation', () => {
    mocks.granted = false;
    pathname = '/about';
    window.history.replaceState(null, '', '/about?utm_source=google&utm_medium=cpc&utm_campaign=launch&gclid=click');
    const view = render(<AnalyticsClient />);
    expect(mocks.pageview).not.toHaveBeenCalled();
    expect(mocks.capturePosthog).not.toHaveBeenCalled();
    pathname = '/privacy';
    window.history.replaceState(null, '', '/privacy');
    view.rerender(<AnalyticsClient />);
    expect(mocks.pageview).not.toHaveBeenCalled();
    mocks.granted = true;
    view.rerender(<AnalyticsClient />);
    expect(mocks.pageview).toHaveBeenCalledWith('/privacy');
    expect(getSessionInboundCampaign()).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'launch',
      gclid: 'click',
    });
  });

  it('sends path-only PostHog pageviews', async () => {
    pathname = '/b/kilter/list';

    render(<AnalyticsClient />);

    await waitFor(() => {
      expect(mocks.pageview).toHaveBeenCalledWith('/b/kilter/list');
    });
  });

  it('skips localized admin pageviews', async () => {
    pathname = '/fr/admin/retention';

    render(<AnalyticsClient />);

    await waitFor(() => {
      expect(mocks.pageview).not.toHaveBeenCalled();
    });
  });

  it('batches all four web vitals into one PostHog event', async () => {
    render(<AnalyticsClient />);

    await waitFor(() => {
      expect(mocks.vitalCallbacks.length).toBeGreaterThan(0);
    });

    const reportVital = mocks.vitalCallbacks[0];
    reportVital({ name: 'LCP', value: 123.4, rating: 'good', delta: 12.3, id: 'lcp-1', navigationType: 'navigate' });
    reportVital({ name: 'CLS', value: 0.05, rating: 'good', delta: 0.05, id: 'cls-1', navigationType: 'navigate' });
    reportVital({ name: 'FCP', value: 800, rating: 'good', delta: 800, id: 'fcp-1', navigationType: 'navigate' });
    reportVital({
      name: 'INP',
      value: 50,
      rating: 'needs-improvement',
      delta: 50,
      id: 'inp-1',
      navigationType: 'navigate',
    });

    expect(mocks.capturePosthog).toHaveBeenCalledTimes(1);
    expect(mocks.capturePosthog).toHaveBeenCalledWith('$web_vitals', {
      $current_url: '/',
      $web_vitals_LCP_value: 123.4,
      $web_vitals_LCP_rating: 'good',
      $web_vitals_LCP_delta: 12.3,
      $web_vitals_LCP_id: 'lcp-1',
      $web_vitals_LCP_navigation_type: 'navigate',
      $web_vitals_CLS_value: 0.05,
      $web_vitals_CLS_rating: 'good',
      $web_vitals_CLS_delta: 0.05,
      $web_vitals_CLS_id: 'cls-1',
      $web_vitals_CLS_navigation_type: 'navigate',
      $web_vitals_FCP_value: 800,
      $web_vitals_FCP_rating: 'good',
      $web_vitals_FCP_delta: 800,
      $web_vitals_FCP_id: 'fcp-1',
      $web_vitals_FCP_navigation_type: 'navigate',
      $web_vitals_INP_value: 50,
      $web_vitals_INP_rating: 'needs-improvement',
      $web_vitals_INP_delta: 50,
      $web_vitals_INP_id: 'inp-1',
      $web_vitals_INP_navigation_type: 'navigate',
    });
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('flushes a partial buffer after the 5s timer elapses', async () => {
    render(<AnalyticsClient />);

    await waitFor(() => {
      expect(mocks.vitalCallbacks.length).toBeGreaterThan(0);
    });

    vi.useFakeTimers();
    const reportVital = mocks.vitalCallbacks[0];
    reportVital({ name: 'LCP', value: 200, rating: 'good', delta: 200, id: 'lcp-2', navigationType: 'navigate' });

    expect(mocks.capturePosthog).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);

    expect(mocks.capturePosthog).toHaveBeenCalledTimes(1);
    expect(mocks.capturePosthog).toHaveBeenCalledWith(
      '$web_vitals',
      expect.objectContaining({
        $current_url: '/',
        $web_vitals_LCP_value: 200,
        $web_vitals_LCP_rating: 'good',
        $web_vitals_LCP_id: 'lcp-2',
      }),
    );
  });
});

vi.mock('@/app/components/consent/consent-provider', () => ({
  useConsent: () => ({ granted: mocks.granted, openChoices: vi.fn() }),
}));

vi.mock('@/app/lib/consent', () => ({ hasAnalyticsConsent: () => mocks.granted }));
