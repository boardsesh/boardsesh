// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted, per-test-configurable view of the global state the bar reads.
const cfg = vi.hoisted(() => ({
  onClimbsTab: true,
  insideTabs: true,
  // The bar shows only on a top-level tab page; `onAccessorySurface` (top-level OR
  // player) additionally drives the bottom-chrome arbitration the bar reads.
  onTopLevelTab: true,
  onAccessorySurface: true,
  currentClimbQueueItem: { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem | null,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  measuredTabBarHeight: null as number | null,
  nativeAccessoryActive: false,
  nativeTabBar: false,
}));

// useAccessoryClimbTap builds a preview queue item via climbToQueueItem, which
// pulls expo-crypto's randomUUID — stub it so the native module isn't loaded.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  // Expose `style` as `data-style` so positioning assertions can query the outer
  // plain View shell (which now owns the absolute layout, not the Animated.View).
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-animated': 'true', 'data-style': JSON.stringify(style) }, children),
  },
  FadeIn: { duration: () => ({}) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ useSegments: () => [] }));
vi.mock('../../../lib/route-segments', () => ({
  isClimbsTabRoute: () => cfg.onClimbsTab,
  isTabsRoute: () => cfg.insideTabs,
  // The player route counts as chrome-mounted; these tests don't exercise /play,
  // so it tracks the same `insideTabs` config as the tab-chrome predicate.
  isTabsChromeRoute: () => cfg.insideTabs,
  // The bar's own route gate (top-level tab only) and the bottom-chrome surface gate.
  isTopLevelTabRoute: () => cfg.onTopLevelTab,
  isAccessorySurfaceRoute: () => cfg.onAccessorySurface,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem } }),
  useHasActiveClimb: () => cfg.currentClimbQueueItem?.climb != null,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../../../theme/animations', () => ({ timing: { fast: 150, normal: 250 } }));
vi.mock('../../../theme/layout', () => ({
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT: 48,
  MATERIAL_TAB_BAR_HEIGHT: 80,
  TAB_BAR_HEIGHT: 49,
  TOOLBAR_RESERVE: 74,
  TOOLBAR_SIDE_MARGIN: 16,
  TOOLBAR_GAP: 8,
  TOOLBAR_FAB_SIZE: 56,
  TOOLBAR_GAP_ABOVE_TABBAR: 10,
  TABBAR_SEAM_OVERLAP: 1,
  glassSize: { hero: 64, inline: 44 },
}));
// The docked Material bar reads the tab bar's measured height to position itself.
vi.mock('../../../providers/tab-bar-height-provider', () => ({
  useMeasuredTabBarHeight: () => cfg.measuredTabBarHeight,
  useSetMeasuredTabBarHeight: () => vi.fn(),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4 } }));
// Default to the Liquid Glass layout (centered capsule + standalone hero tick).
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: cfg.variant }) }));
// The floating bar renders only where the native bottom accessory doesn't
// (Material variant / iOS < 26 / Android) — force that path so the capsule/tick
// assertions hold. `useNativeAccessoryActive` is what use-bottom-chrome-metrics
// reads now (variant-aware); the capability function stays for other callers.
vi.mock('../../../hooks/use-bottom-accessory', () => ({
  isBottomAccessoryAvailable: () => false,
  // Drive each hook from its own flag: the native tab bar and the native accessory
  // can diverge (e.g. a capable device with no current climb mounts the bar but not
  // the accessory), so the tests keep them independent.
  useNativeAccessoryActive: () => cfg.nativeAccessoryActive,
  useNativeTabBar: () => cfg.nativeTabBar,
}));
vi.mock('../ClimbCapsule', () => ({
  ClimbCapsule: ({
    fillWidth,
    height,
    surfaceTreatment,
    endAction,
  }: {
    fillWidth?: boolean;
    height?: number;
    surfaceTreatment?: string;
    endAction?: ReactNode;
  }) =>
    createElement(
      'div',
      {
        'data-capsule': 'true',
        'data-fill-width': fillWidth ? 'true' : 'false',
        'data-height': height == null ? '' : String(height),
        'data-surface-treatment': surfaceTreatment ?? '',
      },
      endAction,
    ),
}));
vi.mock('../LogAscentFab', () => ({
  LogAscentFab: ({ climb }: { climb: { uuid: string } }) =>
    createElement('div', { 'data-tick': 'true', 'data-climb-uuid': climb.uuid }),
}));
vi.mock('../LogAscentToolbarButton', () => ({
  LogAscentToolbarButton: ({ climb }: { climb: { uuid: string } }) =>
    createElement('div', { 'data-tick-inline': 'true', 'data-climb-uuid': climb.uuid }),
}));

import { PersistentQueueBar } from '../persistent-queue-bar';

describe('PersistentQueueBar', () => {
  beforeEach(() => {
    cfg.onClimbsTab = true;
    cfg.insideTabs = true;
    cfg.onTopLevelTab = true;
    cfg.onAccessorySurface = true;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem;
    cfg.variant = 'liquidGlass';
    cfg.measuredTabBarHeight = null;
    cfg.nativeAccessoryActive = false;
    cfg.nativeTabBar = false;
  });

  it('renders nothing when no climb is current', () => {
    cfg.currentClimbQueueItem = null;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
  });

  it('shows the capsule and standalone tick on a top-level tab page', () => {
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('renders nothing on a pushed sub-route inside a tab', () => {
    // Session detail, climb filters, settings — a tab sub-route is not a top-level
    // tab page, so the climb bar is hidden there even with a current climb.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the gym-discovery map route', () => {
    // The /gyms screen is a full-bleed map — not a top-level tab, so the climb bar
    // is suppressed there even with a current climb.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the auth (login) route', () => {
    // Pre-auth screens aren't tabs — a leftover queued or "on the wall" climb must
    // not float a tick bar over the login screen.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the full-screen player route', () => {
    // The /play player owns the whole surface. The native accessory host stays
    // mounted (occluded) under the transparent player, so `onAccessorySurface` is
    // true — but it's not a top-level tab, so the JS bar is gated off by route.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = true;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('does not render the JS toolbar when the native bottom accessory is active', () => {
    cfg.nativeAccessoryActive = true;
    cfg.nativeTabBar = true;
    cfg.insideTabs = true;

    const { container } = render(<PersistentQueueBar />);

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing outside the top-level tabs even when the native accessory path is active', () => {
    // The bar is restricted to top-level tab pages, so a glass-capable device on a
    // non-tab / root surface shows nothing (it used to keep a JS fallback here).
    cfg.nativeAccessoryActive = true;
    cfg.nativeTabBar = true;
    cfg.insideTabs = false;
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;

    const { container } = render(<PersistentQueueBar />);

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('shows the tick on every top-level tab — parity with the always-on native accessory', () => {
    // Even off the Climbs tab (e.g. the Profile tab index) the fallback keeps the
    // tick so an ascent can be logged, matching the iOS 26 bottom accessory.
    cfg.onClimbsTab = false;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('uses a docked full-width inline-action bar on Material', () => {
    cfg.variant = 'material';
    const { container } = render(<PersistentQueueBar />);
    const capsule = container.querySelector('[data-capsule]');
    expect(capsule).not.toBeNull();
    expect(capsule?.getAttribute('data-fill-width')).toBe('true');
    expect(capsule?.getAttribute('data-height')).toBe('48');
    expect(capsule?.getAttribute('data-surface-treatment')).toBe('docked');
    // Positioning lives on the outer plain View shell (parentElement of the
    // Animated.View), not on the Animated.View itself — the Reanimated entering
    // bug was fixed by separating the positioning View from the animated View.
    expect(container.querySelector('[data-animated]')?.parentElement?.getAttribute('data-style')).toContain('"left":0');
    expect(container.querySelector('[data-animated]')?.parentElement?.getAttribute('data-style')).toContain(
      '"right":0',
    );
    expect(container.querySelector('[data-tick-inline]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing when the local queue is empty — the wall climb lives in the top strip now', () => {
    // The bar shows the user's own queue head only; a climb lit on the wall (e.g. a
    // teammate's) is surfaced by the top "On the wall" strip, never this bottom bar.
    cfg.currentClimbQueueItem = null;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('docks the Material bar on the measured tab-bar top, tucked under the hairline', () => {
    // Measured tab bar = 80px tall → the docked bar sits at 80 - TABBAR_SEAM_OVERLAP(1).
    cfg.variant = 'material';
    cfg.measuredTabBarHeight = 80;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-animated]')?.parentElement?.getAttribute('data-style')).toContain(
      '"bottom":79',
    );
  });
});
