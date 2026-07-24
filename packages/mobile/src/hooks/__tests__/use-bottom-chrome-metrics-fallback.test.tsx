// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { BottomChromeMetrics } from '../bottom-chrome-metrics';

// Force the RELEASE-build path: a consumer outside the provider must NOT throw.
// Under vitest `__DEV__` is statically `true` (vite.config.ts define), so without
// mocking this seam the fallback branch is unreachable dead code no test can cover.
vi.mock('../bottom-chrome-provider-gate', () => ({ shouldThrowOnMissingProvider: () => false }));

// Capture the one-per-launch report the fallback fires. Mocking the whole module
// also keeps the sentry import chain out of this test.
const report = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: report.reportHandledError }));

// Leaf-input mocks so importing the module resolves cleanly in jsdom. The provider
// is never rendered in these tests, so the values themselves are irrelevant.
vi.mock('expo-router', () => ({ useSegments: () => ['(tabs)', 'home'] }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 430, height: 900 }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ variant: 'material' }) }));
vi.mock('../use-bottom-accessory', () => ({ isBottomAccessoryAvailable: () => false, useNativeTabBar: () => false }));
vi.mock('../use-device-layout', () => ({ useDeviceLayout: () => ({ widthClass: 'compact' }) }));
vi.mock('../use-sticky-accessory-presence', () => ({ useStickyAccessoryPresence: () => false }));

import { useBottomChromeMetrics, FALLBACK_BOTTOM_CHROME_METRICS } from '../use-bottom-chrome-metrics';

let received: BottomChromeMetrics | undefined;
function BareConsumer() {
  received = useBottomChromeMetrics();
  return null;
}

describe('useBottomChromeMetrics release-build fallback (rendered outside the provider)', () => {
  beforeEach(() => {
    report.reportHandledError.mockClear();
    received = undefined;
  });

  it('degrades to the conservative fallback instead of throwing, and reports once', () => {
    // Two bare consumers, then a re-render — four out-of-provider reads total. In a
    // release build the throw is suppressed on every one; they all get the shared
    // no-chrome baseline, and the mount-tree bug is reported exactly once per launch.
    const view = render(
      <>
        <BareConsumer />
        <BareConsumer />
      </>,
    );
    // No throw, and the value returned is the shared conservative fallback.
    expect(received).toBe(FALLBACK_BOTTOM_CHROME_METRICS);
    expect(received?.jsQueueToolbarVisible).toBe(false);

    view.rerender(
      <>
        <BareConsumer />
        <BareConsumer />
      </>,
    );

    // The module-level guard keeps error tracking from flooding: one report across
    // all four renders, carrying the source tag for triage.
    expect(report.reportHandledError).toHaveBeenCalledTimes(1);
    const [error, context] = report.reportHandledError.mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown> } | undefined,
    ];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/outside BottomChromeMetricsProvider/);
    expect(context?.tags?.source).toBe('bottom-chrome-fallback');
  });
});
