// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted, per-test-configurable view of the global state the bar reads.
const cfg = vi.hoisted(() => ({
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
  widthClass: 'compact' as 'compact' | 'regular',
  windowWidth: 430,
  sessionId: null as string | null,
  activeSegment: null as string | null,
}));
vi.mock('../../../lib/workout-run-store', () => ({ useWorkoutRunPendingStart: () => false }));

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
  useWindowDimensions: () => ({ width: cfg.windowWidth, height: 932 }),
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
  isTabsRoute: () => cfg.insideTabs,
  // The player route counts as chrome-mounted; these tests don't exercise /play,
  // so it tracks the same `insideTabs` config as the tab-chrome predicate.
  isTabsChromeRoute: () => cfg.insideTabs,
  // None of these tests opens the Wall display.
  isWallDisplayRoute: () => false,
  // None of these tests sits on the Session page, where the rest pill hides.
  isRestTimerPillHiddenRoute: () => false,
  // The bar's own route gate (top-level tab only) and the bottom-chrome surface gate.
  isTopLevelTabRoute: () => cfg.onTopLevelTab,
  isAccessorySurfaceRoute: () => cfg.onAccessorySurface,
  // The native accessory host's MOUNT gate — wider than the surface gate above, and
  // identical to the tab-chrome one (#5055). These tests are the JS bar's, so it tracks
  // `insideTabs` exactly as isTabsChromeRoute does.
  isAccessoryHostRoute: () => cfg.insideTabs,
  isAccessoryHiddenRoute: () => false,
  tabsActiveSegment: () => cfg.activeSegment,
}));
// useBottomChromeMetrics now reads the device layout; in jsdom this test runs as
// a compact phone (no sidebar), so the bottom-chrome arithmetic is unchanged.
vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({
    widthClass: cfg.widthClass,
    expanded: cfg.windowWidth >= 1024,
    isTablet: cfg.widthClass === 'regular',
  }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem } }),
  useQueueData: () => ({ currentClimbQueueItem: cfg.currentClimbQueueItem }),
  useHasActiveClimb: () => cfg.currentClimbQueueItem?.climb != null,
  useQueueSessionId: () => ({ sessionId: cfg.sessionId }),
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../../../theme/animations', () => ({ timing: { fast: 150, normal: 250 } }));
vi.mock('../../../theme/layout', () => ({
  MATERIAL_MINI_PLAYER_CARD_GAP: 0,
  MATERIAL_MINI_PLAYER_CARD_RESERVE: 48,
  MATERIAL_TAB_BAR_HEIGHT: 64,
  NATIVE_BOTTOM_ACCESSORY_HEIGHT: 56,
  TAB_BAR_HEIGHT: 49,
  TOOLBAR_RESERVE: 74,
  TOOLBAR_SIDE_MARGIN: 16,
  TOOLBAR_GAP: 8,
  TOOLBAR_FAB_SIZE: 56,
  TOOLBAR_GAP_ABOVE_TABBAR: 10,
  SIDEBAR_WIDTH: 96,
  // Mirrors the real implementation — ActiveContextBar's floating branch calls it.
  floatingContextBarBottom: (tabBarBottom: number, gapAboveTabBar = 10) => tabBarBottom + gapAboveTabBar,
  glassSize: { hero: 64, inline: 44 },
}));
// The Material card reads the tab bar's measured height to position itself.
vi.mock('../../../providers/tab-bar-height-provider', () => ({
  useMeasuredTabBarHeight: () => cfg.measuredTabBarHeight,
  useSetMeasuredTabBarHeight: () => vi.fn(),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4 } }));
// Default to the Liquid Glass layout (centered capsule + standalone hero tick).
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: cfg.variant }) }));
// The floating bar renders only where the native bottom accessory doesn't
// (Material variant / iOS 18 / Android / tablets) — force that path so the
// capsule/tick assertions hold. use-bottom-chrome-metrics reads the accessory from
// the same useTabChrome() answer the tab layout mounts from, so model it off the
// `nativeAccessoryActive` flag (its two callers also set nativeTabBar=true).
vi.mock('../../../hooks/use-bottom-accessory', () => ({
  // Keep accessory availability and the native tab bar independent: a capable device
  // with no current climb mounts the tab bar but not the accessory, so the one-call
  // arbitration in use-bottom-chrome-metrics must see the two flags vary separately.
  useTabChrome: () => ({
    nativeTabBar: cfg.nativeTabBar,
    liquidGlassTabBar: cfg.nativeTabBar,
    nativeAccessory: cfg.nativeTabBar && cfg.nativeAccessoryActive,
  }),
}));
vi.mock('../ClimbCapsule', () => ({
  ClimbCapsule: ({ endAction, endActionSize }: { endAction?: ReactNode; endActionSize?: number }) =>
    createElement(
      'div',
      {
        'data-capsule': 'true',
        'data-end-action-size': endActionSize == null ? '' : String(endActionSize),
      },
      endAction,
    ),
}));
vi.mock('../../navigation/FloatingMiniPlayerCard', () => ({
  FloatingMiniPlayerCard: () => createElement('div', { 'data-mini-player-card': 'true' }),
}));
vi.mock('../LogAscentFab', () => ({
  LogAscentFab: ({ climb }: { climb: { uuid: string } }) =>
    createElement('div', { 'data-tick': 'true', 'data-climb-uuid': climb.uuid }),
}));
vi.mock('../ReturnToSessionButton', () => ({
  ReturnToSessionButton: () => createElement('div', { 'data-return-to-session': 'true' }),
}));

// Marks what follows the hiding Android nav bar, so a test can tell a wrapped
// control from one left behind.
vi.mock('../../navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-follower': 'true' }, children),
}));

import { PersistentQueueBar } from '../persistent-queue-bar';
import { BottomChromeMetricsProvider } from '../../../hooks/use-bottom-chrome-metrics';
// Resolves to the layout mock above, which mirrors theme/layout's `glassSize`.
// Assertions read it instead of repeating the literal, so retuning the ladder is
// a one-line mock change rather than an opaque value mismatch.
import { glassSize } from '../../../theme/layout';

// The bar reads useBottomChromeMetrics(), which now requires the provider (the
// geometry is computed once at the tab root). All the leaf inputs the provider
// gathers are mocked above, so wrapping here exercises the real arbitration.
const renderBar = () =>
  render(
    <BottomChromeMetricsProvider>
      <PersistentQueueBar />
    </BottomChromeMetricsProvider>,
  );

describe('PersistentQueueBar', () => {
  beforeEach(() => {
    cfg.insideTabs = true;
    cfg.onTopLevelTab = true;
    cfg.onAccessorySurface = true;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem;
    cfg.variant = 'liquidGlass';
    cfg.measuredTabBarHeight = null;
    cfg.nativeAccessoryActive = false;
    cfg.nativeTabBar = false;
    cfg.widthClass = 'compact';
    cfg.windowWidth = 430;
    cfg.sessionId = null;
    cfg.activeSegment = null;
  });

  it('renders nothing when no climb is current', () => {
    cfg.currentClimbQueueItem = null;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
  });

  it('shows the capsule and standalone tick on a top-level tab page', () => {
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('renders nothing on a pushed sub-route inside a tab', () => {
    // Session detail, climb filters, settings — a tab sub-route is not a top-level
    // tab page, so the climb bar is hidden there even with a current climb.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the gym-discovery map route', () => {
    // The /gyms screen is a full-bleed map — not a top-level tab, so the climb bar
    // is suppressed there even with a current climb.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the auth (login) route', () => {
    // Pre-auth screens aren't tabs — a leftover queued or "on the wall" climb must
    // not float a tick bar over the login screen.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the create-board / edit-board screens (regression test for #3298)', () => {
    // `boards` is a root push, not a top-level tab page — a leftover queued climb
    // must not float the bar over BoardForm's pinned submit button. Before #3253's
    // allow-list rewrite the route gate was a deny-list (auth/gyms/player only)
    // that let this fall through and cover the create-board CTA (#3298).
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('renders nothing on the full-screen player route', () => {
    // The /play player owns the whole surface. The native accessory host stays
    // mounted (occluded) under the transparent player, so `onAccessorySurface` is
    // true — but it's not a top-level tab, so the JS bar is gated off by route.
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = true;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('does not render the JS toolbar when the native bottom accessory is active', () => {
    cfg.nativeAccessoryActive = true;
    cfg.nativeTabBar = true;
    cfg.insideTabs = true;

    const { container } = renderBar();

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

    const { container } = renderBar();

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('shows the tick on every top-level tab — parity with the always-on native accessory', () => {
    // Even off the Climbs tab (e.g. the Profile tab index) the fallback keeps the
    // tick so an ascent can be logged, matching the iOS 26 bottom accessory.
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('floats the MiniPlayer card 8dp in from each edge on Material, with no glass capsule or tick', () => {
    cfg.variant = 'material';
    const { container } = renderBar();
    expect(container.querySelector('[data-mini-player-card]')).not.toBeNull();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    // Positioning lives on the outer plain View shell (parentElement of the
    // Animated.View), not on the Animated.View itself — the Reanimated entering
    // bug was fixed by separating the positioning View from the animated View.
    const shellStyle = container.querySelector('[data-animated]')?.parentElement?.getAttribute('data-style');
    expect(shellStyle).toContain('"left":8');
    expect(shellStyle).toContain('"right":8');
    // The card's row holds ✓, so no standalone tick floats beside it.
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('keeps every gate on Material: no card on a pushed sub-route or without a climb', () => {
    cfg.variant = 'material';
    cfg.onTopLevelTab = false;
    cfg.onAccessorySurface = false;
    expect(renderBar().container.querySelector('[data-mini-player-card]')).toBeNull();
    cfg.onTopLevelTab = true;
    cfg.onAccessorySurface = true;
    cfg.currentClimbQueueItem = null;
    expect(renderBar().container.querySelector('[data-mini-player-card]')).toBeNull();
  });

  it('renders nothing when the local queue is empty — the wall climb lives in the top strip now', () => {
    // The bar shows the user's own queue head only; a climb lit on the wall (e.g. a
    // teammate's) is surfaced by the top "On the wall" strip, never this bottom bar.
    cfg.currentClimbQueueItem = null;
    const { container } = renderBar();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('sits the Material card straight on the measured tab-bar top, no gap', () => {
    // Measured tab bar = 64px tall → the card sits at 64 + MATERIAL_MINI_PLAYER_CARD_GAP(0).
    cfg.variant = 'material';
    cfg.measuredTabBarHeight = 64;
    const { container } = renderBar();
    expect(container.querySelector('[data-animated]')?.parentElement?.getAttribute('data-style')).toContain(
      '"bottom":64',
    );
  });

  it('renders in tight regular tablet-shell widths where the detail pane is suppressed', () => {
    cfg.widthClass = 'regular';
    cfg.windowWidth = 744;

    const { container } = renderBar();

    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('stays hidden in regular tablet-shell widths where the detail pane owns the current climb', () => {
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1024;

    const { container } = renderBar();

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('stays hidden on a native iPad mini in portrait, where the accessory carries the climb', () => {
    // The mini portrait window (744) is too narrow for the tablet shell's pane, so
    // the old width budget brought this bar back over the native accessory: two
    // mini players on one screen.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 744;
    cfg.nativeTabBar = true;
    cfg.nativeAccessoryActive = true;

    const { container } = renderBar();

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('floats on a native iPad without the iOS 26 accessory, like an iOS 18 iPhone', () => {
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1180;
    cfg.nativeTabBar = true;
    cfg.nativeAccessoryActive = false;

    const { container } = renderBar();

    expect(container.querySelector('[data-capsule]')).not.toBeNull();
  });

  describe('return-to-session affordance (#2563)', () => {
    it('shows the return-to-session button in the capsule endAction when a session is live and not on Record', () => {
      cfg.sessionId = 'session-1';
      cfg.activeSegment = 'home';
      const { container } = renderBar();
      const capsule = container.querySelector('[data-capsule]');
      expect(capsule?.querySelector('[data-return-to-session]')).not.toBeNull();
      expect(capsule?.getAttribute('data-end-action-size')).toBe(String(glassSize.inline));
    });

    it('omits the return-to-session button when no session is live', () => {
      cfg.sessionId = null;
      cfg.activeSegment = 'home';
      const { container } = renderBar();
      const capsule = container.querySelector('[data-capsule]');
      expect(capsule?.querySelector('[data-return-to-session]')).toBeNull();
    });

    it('omits the return-to-session button while already on the Record tab', () => {
      cfg.sessionId = 'session-1';
      cfg.activeSegment = 'record';
      const { container } = renderBar();
      const capsule = container.querySelector('[data-capsule]');
      expect(capsule?.querySelector('[data-return-to-session]')).toBeNull();
    });

    it('keeps the Material card free of the return-to-session button during a session', () => {
      cfg.variant = 'material';
      cfg.sessionId = 'session-1';
      cfg.activeSegment = 'home';
      const { container } = renderBar();
      expect(container.querySelector('[data-mini-player-card]')).not.toBeNull();
      expect(container.querySelector('[data-return-to-session]')).toBeNull();
    });
  });

  describe('follows the hiding Android nav bar', () => {
    it('moves the Material card with the bar', () => {
      cfg.variant = 'material';
      const { container } = renderBar();
      expect(container.querySelector('[data-follower] [data-mini-player-card]')).not.toBeNull();
    });

    it('moves the glass capsule and tick with the bar, so the rest pill above never lands on them', () => {
      // An Android phone with the Liquid Glass preference still gets the
      // Material bar and hide-on-scroll; the rest pill follows it, so must this.
      cfg.variant = 'liquidGlass';
      const { container } = renderBar();
      expect(container.querySelector('[data-follower] [data-capsule]')).not.toBeNull();
      expect(container.querySelector('[data-follower] [data-tick]')).not.toBeNull();
    });
  });
});
