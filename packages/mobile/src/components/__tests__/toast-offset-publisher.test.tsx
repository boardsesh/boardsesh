// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBottomChromeMetrics, type BottomChromeInputs } from '../../hooks/bottom-chrome-metrics';
import { isAccessorySurfaceRoute, isTabsChromeRoute } from '../../lib/route-segments';

// The route + chrome state the publisher sees. Metrics are built with the real
// computeBottomChromeMetrics and the real route predicates, so `/play` and
// `/onboarding` count as tab chrome exactly as they do in the provider.
const ctrl = vi.hoisted(() => ({
  segments: ['(tabs)', 'climbs'] as string[],
  chrome: {} as Record<string, unknown>,
}));

vi.mock('expo-router', () => ({ useSegments: () => ctrl.segments }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => {
    const inputs: BottomChromeInputs = {
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: isTabsChromeRoute(ctrl.segments),
      onAccessorySurface: isAccessorySurfaceRoute(ctrl.segments),
      hasCurrentClimb: false,
      nativeAccessoryPresented: false,
      ...ctrl.chrome,
    };
    return computeBottomChromeMetrics(inputs);
  },
}));

import { ToastOffsetPublisher } from '../ToastOffsetPublisher';
import { resetToastBottomOffsetForTests, usePublishedToastBottomOffset } from '../../lib/toast-offset-store';

let published: number | null = null;
function Reader() {
  published = usePublishedToastBottomOffset();
  return null;
}

function publishedOffset(): number | null {
  render(
    <>
      <ToastOffsetPublisher />
      <Reader />
    </>,
  );
  return published;
}

beforeEach(() => {
  ctrl.segments = ['(tabs)', 'climbs'];
  ctrl.chrome = {};
  published = null;
  act(() => resetToastBottomOffsetForTests());
});

describe('ToastOffsetPublisher', () => {
  // Offsets in pt a climber gets, root inset 34 (a Face ID iPhone; the same
  // number stands in for an Android gesture bar so the rows compare). On a tab
  // route each one is the shared floatingControlBottom plus the 8pt gap the
  // queue snackbars leave, so a toast and a snackbar never sit apart.
  it.each([
    {
      name: 'Material, no climb: clears the 80dp nav bar, reserves no queue bar',
      chrome: {},
      bottom: 34 + 80 + 8,
    },
    {
      name: 'Material, climb on the wall: also clears the 48dp queue bar',
      chrome: { hasCurrentClimb: true },
      bottom: 34 + 80 + 48 + 8,
    },
    {
      name: 'Material, pushed tab route: no queue bar there, so none reserved',
      segments: ['(tabs)', 'home', 'session', '[sessionId]'],
      chrome: { hasCurrentClimb: true },
      bottom: 34 + 80 + 8,
    },
    {
      // Keyed on the bar actually rendered: the JS fallback bar is 80pt tall,
      // not the 49pt native one.
      name: 'Liquid Glass JS fallback, climb: 80pt JS bar + 66pt floating queue bar',
      chrome: { uiVariant: 'liquidGlass', hasCurrentClimb: true },
      bottom: 34 + 80 + 66 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, no climb, measured 83pt in-tab inset',
      chrome: {
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        nativeAccessoryPresented: true,
        measuredTabContentInsetBottom: 83,
      },
      bottom: 83 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, accessory up, measured 139pt (DEVICE_VERIFIED iPhone 17 Pro)',
      chrome: {
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        nativeAccessoryPresented: true,
        hasCurrentClimb: true,
        measuredTabContentInsetBottom: 139,
      },
      bottom: 139 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, accessory up, before the probe publishes: still clears the platter',
      chrome: {
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        nativeAccessoryPresented: true,
        hasCurrentClimb: true,
      },
      bottom: 34 + 49 + 56 + 8,
    },
    {
      name: 'Material, rest timer armed: lifts over the 54pt pill',
      chrome: { restTimerArmed: true },
      bottom: 34 + 80 + 54 + 8,
    },
    {
      name: 'connectivity banner showing: lifts over its measured height',
      chrome: { connectivityBannerHeight: 40 },
      bottom: 34 + 80 + 40 + 8,
    },
    {
      name: 'off the tabs: home indicator + gap only, even with the timer armed',
      segments: ['gym', '123'],
      chrome: { hasCurrentClimb: true, restTimerArmed: true },
      bottom: 34 + 8,
    },
    // /play and /onboarding count as tab chrome in the metrics (so the bar
    // geometry doesn't churn under them), but no tab bar or queue bar is
    // visible there. A toast after a tick in the play drawer must sit low,
    // not over the board art.
    {
      name: '/play, climb on the wall, timer armed: root inset + gap, not over the board',
      segments: ['play'],
      chrome: { hasCurrentClimb: true, restTimerArmed: true },
      bottom: 34 + 8,
    },
    {
      name: '/play with the connectivity banner: clears only the banner',
      segments: ['play'],
      chrome: { hasCurrentClimb: true, connectivityBannerHeight: 40 },
      bottom: 34 + 40 + 8,
    },
    {
      name: '/onboarding: root inset + gap',
      segments: ['onboarding'],
      chrome: {},
      bottom: 34 + 8,
    },
  ])('$name', ({ segments, chrome, bottom }) => {
    if (segments) ctrl.segments = segments;
    ctrl.chrome = chrome;
    expect(publishedOffset()).toBe(bottom);
  });
});
