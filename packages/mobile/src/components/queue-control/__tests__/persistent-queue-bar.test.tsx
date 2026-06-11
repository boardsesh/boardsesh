// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted, per-test-configurable view of the global state the bar reads.
const cfg = vi.hoisted(() => ({
  onClimbsTab: true,
  insideTabs: true,
  currentClimbQueueItem: { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem | null,
  wallClimb: null as null | { uuid: string; angle: number },
  sessionId: null as string | null,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  measuredTabBarHeight: null as number | null,
  nativeAccessoryActive: false,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem }, sessionId: cfg.sessionId }),
  useHasActiveClimb: () => cfg.currentClimbQueueItem?.climb != null || cfg.wallClimb != null,
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
  useNativeAccessoryActive: () => cfg.nativeAccessoryActive,
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
vi.mock('../use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: { uuid: string; angle: number } | null) => cfg.wallClimb ?? localClimb,
  useIsWallPinned: () => cfg.wallClimb != null,
}));
vi.mock('../LogAscentFab', () => ({
  LogAscentFab: ({ climb }: { climb: { uuid: string } }) =>
    createElement('div', { 'data-tick': 'true', 'data-climb-uuid': climb.uuid }),
}));
vi.mock('../LogAscentToolbarButton', () => ({
  LogAscentToolbarButton: ({ climb }: { climb: { uuid: string } }) =>
    createElement('div', { 'data-tick-inline': 'true', 'data-climb-uuid': climb.uuid }),
}));
vi.mock('../RepTimerCapsule', () => ({
  RepTimerCapsule: ({
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
        'data-rep-timer': 'true',
        'data-fill-width': fillWidth ? 'true' : 'false',
        'data-height': height == null ? '' : String(height),
        'data-surface-treatment': surfaceTreatment ?? '',
      },
      endAction,
    ),
}));

import { PersistentQueueBar } from '../persistent-queue-bar';

describe('PersistentQueueBar', () => {
  beforeEach(() => {
    cfg.onClimbsTab = true;
    cfg.insideTabs = true;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem;
    cfg.wallClimb = null;
    cfg.sessionId = null;
    cfg.variant = 'liquidGlass';
    cfg.measuredTabBarHeight = null;
    cfg.nativeAccessoryActive = false;
  });

  it('renders nothing when no climb is current', () => {
    cfg.currentClimbQueueItem = null;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).toBeNull();
  });

  it('shows the capsule and standalone tick when a climb is current', () => {
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
    expect(container.querySelector('[data-rep-timer]')).toBeNull();
  });

  it('shows the rep timer instead of the climb capsule during an active session', () => {
    cfg.sessionId = 'session-1';
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-rep-timer]')).not.toBeNull();
    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('does not render the JS toolbar when the native bottom accessory is active', () => {
    cfg.nativeAccessoryActive = true;
    cfg.insideTabs = true;

    const { container } = render(<PersistentQueueBar />);

    expect(container.querySelector('[data-capsule]')).toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('keeps the JS toolbar fallback outside tabs when the native accessory path is active', () => {
    cfg.nativeAccessoryActive = true;
    cfg.insideTabs = false;

    const { container } = render(<PersistentQueueBar />);

    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).not.toBeNull();
  });

  it('shows the tick on every tab — parity with the always-on native accessory', () => {
    // Even off the Climbs tab the fallback keeps the tick so an ascent can be
    // logged from anywhere, matching the iOS 26 bottom accessory.
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
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"left":0');
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"right":0');
    expect(container.querySelector('[data-tick-inline]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')).toBeNull();
  });

  it('uses the wall climb for the fallback tick when the local queue is empty', () => {
  it('uses a docked full-width inline-action rep timer on Material during a session', () => {
    cfg.variant = 'material';
    cfg.sessionId = 'session-1';
    const { container } = render(<PersistentQueueBar />);
    const timer = container.querySelector('[data-rep-timer]');
    expect(timer).not.toBeNull();
    expect(timer?.getAttribute('data-fill-width')).toBe('true');
    expect(timer?.getAttribute('data-height')).toBe('48');
    expect(timer?.getAttribute('data-surface-treatment')).toBe('docked');
    expect(container.querySelector('[data-tick-inline]')).not.toBeNull();
    expect(container.querySelector('[data-capsule]')).toBeNull();
  });

  it('uses the wall climb for the fallback tick when the local queue is empty', () => {
    cfg.currentClimbQueueItem = null;
    cfg.wallClimb = { uuid: 'wall-climb', angle: 40 };
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-capsule]')).not.toBeNull();
    expect(container.querySelector('[data-tick]')?.getAttribute('data-climb-uuid')).toBe('wall-climb');
  });

  it('docks the Material bar on the measured tab-bar top, tucked under the hairline', () => {
    // Measured tab bar = 80px tall → the docked bar sits at 80 - TABBAR_SEAM_OVERLAP(1).
    cfg.variant = 'material';
    cfg.measuredTabBarHeight = 80;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"bottom":79');
  });
});
