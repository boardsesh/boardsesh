// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { memo } from 'react';
import type { BottomChromeMetrics } from '../bottom-chrome-metrics';
import {
  publishNativeTabContentInsetBottom,
  resetNativeTabContentInsetForTests,
} from '../../lib/native-tab-content-inset-store';

// Hoisted, per-test-configurable view of the leaf inputs the provider gathers.
// The whole point of the provider is to read these ONCE for the whole app, so
// the test drives them through mocks and asserts consumers share one computed
// value and only re-render on a real geometry change.
const cfg = vi.hoisted(() => ({
  segments: ['(tabs)', 'home'] as readonly string[],
  insetsBottom: 34,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  nativeTabBar: false,
  accessoryAvailable: false,
  hasCurrentClimb: true,
  widthClass: 'compact' as 'compact' | 'regular',
  windowWidth: 430,
}));

vi.mock('expo-router', () => ({ useSegments: () => cfg.segments }));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: cfg.windowWidth, height: 900 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: cfg.insetsBottom, top: 0, left: 0, right: 0 }),
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ variant: cfg.variant }) }));
vi.mock('../use-bottom-accessory', () => ({
  isBottomAccessoryAvailable: () => cfg.accessoryAvailable,
  useNativeTabBar: () => cfg.nativeTabBar,
}));
vi.mock('../use-device-layout', () => ({ useDeviceLayout: () => ({ widthClass: cfg.widthClass }) }));
// Mock the sticky presence wrapper to a plain flag — its internal grace-timer
// state is irrelevant to what this test pins (the fan-out), and this keeps the
// presence input deterministic and free of the queue-provider chain.
vi.mock('../use-sticky-accessory-presence', () => ({ useStickyAccessoryPresence: () => cfg.hasCurrentClimb }));

import { BottomChromeMetricsProvider, useBottomChromeMetrics } from '../use-bottom-chrome-metrics';

// Per-consumer render counters + the last metrics object each consumer received,
// so a test can assert (a) how many times a consumer's body ran and (b) that all
// consumers share ONE object (computed a single time, not once per consumer).
const counts: Record<string, number> = {};
const received: Record<string, BottomChromeMetrics> = {};

function Consumer({ id }: { id: string }) {
  received[id] = useBottomChromeMetrics();
  counts[id] = (counts[id] ?? 0) + 1;
  return null;
}
const MemoConsumer = memo(Consumer);

// `tick` is an unrelated prop: bumping it forces Harness (and thus the provider)
// to re-render without touching any geometry input.
function Harness(_props: { tick: number }) {
  return (
    <BottomChromeMetricsProvider>
      <MemoConsumer id="a" />
      <MemoConsumer id="b" />
      <MemoConsumer id="c" />
    </BottomChromeMetricsProvider>
  );
}

describe('BottomChromeMetricsProvider fan-out', () => {
  beforeEach(() => {
    cfg.segments = ['(tabs)', 'home'];
    cfg.insetsBottom = 34;
    cfg.variant = 'liquidGlass';
    cfg.nativeTabBar = false;
    cfg.accessoryAvailable = false;
    cfg.hasCurrentClimb = true;
    cfg.widthClass = 'compact';
    cfg.windowWidth = 430;
    resetNativeTabContentInsetForTests();
    for (const key of Object.keys(counts)) delete counts[key];
    for (const key of Object.keys(received)) delete received[key];
  });

  it('computes once and shares one metrics object across every consumer', () => {
    render(<Harness tick={0} />);
    // Each consumer rendered exactly once...
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });
    // ...and every one received the SAME object reference — proof the geometry was
    // computed a single time in the provider, not once per consumer.
    expect(received.a).toBe(received.b);
    expect(received.b).toBe(received.c);
    // And it's the real computed geometry, not an empty stub.
    expect(typeof received.a.scrollBottomPadding).toBe('number');
    expect(received.a.jsQueueToolbarVisible).toBe(true);
  });

  it('throws when used outside the provider', () => {
    // Matches the other app-wide context hooks — a bare consumer is a misuse.
    expect(() => render(<Consumer id="bare" />)).toThrow(/BottomChromeMetricsProvider/);
  });

  it('does not re-render consumers on an unrelated parent re-render', () => {
    const { rerender } = render(<Harness tick={0} />);
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });

    // Re-render the tree with only the unrelated `tick` changed. The provider
    // re-runs but its memoized value keeps identity, so no consumer re-renders.
    rerender(<Harness tick={1} />);
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('does not re-render consumers when navigation keeps the same geometry', () => {
    const { rerender } = render(<Harness tick={0} />);
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });

    // Home → Climbs: both are top-level tab pages, so insideTabs / onAccessorySurface
    // (and every derived offset) are unchanged. A geometry-neutral navigation must
    // NOT fan out a re-render across the tree.
    cfg.segments = ['(tabs)', 'climbs'];
    rerender(<Harness tick={1} />);
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('propagates an in-tab inset publish to consumers on the native-tab-bar path', () => {
    // The probe publishes from inside a tab (a different subtree entirely); the
    // provider must pick it up through the store subscription without any
    // re-render of its own parents.
    cfg.nativeTabBar = true;
    cfg.hasCurrentClimb = false;
    render(<Harness tick={0} />);
    // Pre-measurement: the native path reconstructs the bar from the root inset.
    expect(received.a.tabBarBottom).toBe(34 + 49);
    act(() => publishNativeTabContentInsetBottom(90));
    expect(received.a.tabBarBottom).toBe(90);
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it('re-renders every consumer once when the geometry actually changes (presence flips)', () => {
    const { rerender } = render(<Harness tick={0} />);
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });

    // The current climb disappears → the JS queue toolbar reserve collapses, so the
    // geometry genuinely changes and every consumer re-renders exactly once.
    cfg.hasCurrentClimb = false;
    rerender(<Harness tick={1} />);
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
    expect(received.a.jsQueueToolbarVisible).toBe(false);
  });

  it('drops the accessory reserve on a push, though the host stays mounted (#5055)', () => {
    // The UIKit host is held open across the push (see tab-layout.test), but UIKit stops
    // presenting the platter, so the metrics must report it gone and reserve nothing for
    // it. This is the pin against someone re-keying the reserve onto the host gate and
    // reintroducing #3776's dead gap on every sub-route.
    cfg.nativeTabBar = true;
    cfg.accessoryAvailable = true;
    cfg.segments = ['(tabs)', 'discover'];
    const { rerender } = render(<Harness tick={0} />);
    expect(received.a.nativeAccessoryVisible).toBe(true);
    const rootPadding = received.a.scrollBottomPadding;

    cfg.segments = ['(tabs)', 'discover', '[playlist_uuid]'];
    rerender(<Harness tick={1} />);
    expect(received.a.nativeAccessoryVisible).toBe(false);
    expect(received.a.scrollBottomPadding).toBeLessThan(rootPadding);
  });
});
