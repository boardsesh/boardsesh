// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Hoisted, per-test-configurable view of the global state the bar reads.
const cfg = vi.hoisted(() => ({
  onClimbsTab: true,
  currentClimbQueueItem: { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem | null,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  measuredTabBarHeight: null as number | null,
}));

vi.mock('react-native', () => ({
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
  isTabsRoute: () => false,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem } }),
  useHasActiveClimb: () => cfg.currentClimbQueueItem?.climb != null,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../../../theme/animations', () => ({ timing: { fast: 150, normal: 250 } }));
vi.mock('../../../theme/layout', () => ({
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT: 48,
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
  useNativeAccessoryActive: () => false,
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
vi.mock('../LogAscentFab', () => ({ LogAscentFab: () => createElement('div', { 'data-tick': 'true' }) }));
vi.mock('../LogAscentToolbarButton', () => ({
  LogAscentToolbarButton: () => createElement('div', { 'data-tick-inline': 'true' }),
}));

import { PersistentQueueBar } from '../persistent-queue-bar';

describe('PersistentQueueBar', () => {
  beforeEach(() => {
    cfg.onClimbsTab = true;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem;
    cfg.variant = 'liquidGlass';
    cfg.measuredTabBarHeight = null;
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

  it('docks the Material bar on the measured tab-bar top, tucked under the hairline', () => {
    // Measured tab bar = 80px tall → the docked bar sits at 80 - TABBAR_SEAM_OVERLAP(1).
    cfg.variant = 'material';
    cfg.measuredTabBarHeight = 80;
    const { container } = render(<PersistentQueueBar />);
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"bottom":79');
  });
});
