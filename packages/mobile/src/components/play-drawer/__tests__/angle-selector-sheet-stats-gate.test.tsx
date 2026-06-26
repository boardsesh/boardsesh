// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AngleSelectorSheet is always mounted as a PlayDrawer sibling (the stackBehavior=
// push pattern needs an always-mounted modal) and toggled purely by its `visible`
// prop. Its body — including useClimbStatsHistory — runs regardless of whether the
// modal is actually presented. This test pins the regression: the stats-history
// query must stay disabled (uuid passed as null) while the sheet is closed, so it
// doesn't fire CLIMB_STATS_HISTORY for every climb the user swipes through in the
// drawer, and only fetches the real uuid once the sheet is visible.

const stats = vi.hoisted(() => ({
  calls: [] as Array<{ boardName: string; climbUuid: string | null }>,
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useClimbStatsHistory: (boardName: string, climbUuid: string | null) => {
    stats.calls.push({ boardName, climbUuid });
    return { data: undefined };
  },
}));

// Heavy UI / native deps stubbed so the component renders under jsdom. We only
// care that the hook is called with the right uuid for the given `visible` state.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styleSheet: unknown) => styleSheet },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

// Isolate the sheet from the presentation coordinator (its serialization is
// covered by sheet-presentation-provider.test.tsx). This test only pins the
// stats-history fetch gating, so a no-op managed handle is enough.
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ onClose }: { onClose?: () => void }) => ({
    onChange: (index: number) => {
      if (index === -1) onClose?.();
    },
    onFullyDismissed: () => {},
    handle: {
      present: () => {},
      dismiss: () => {},
      close: () => {},
      forceClose: () => {},
      snapToIndex: () => {},
      snapToPosition: () => {},
      expand: () => {},
      collapse: () => {},
    },
  }),
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('@boardsesh/board-config', () => ({ ANGLES: { kilter: [20, 25, 30, 40] } }));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v_grade' }),
}));

vi.mock('../community-utils', () => ({ buildAngleStatsMap: () => new Map() }));

vi.mock('../AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));

vi.mock('../AngleSlider', () => ({ AngleSlider: () => null }));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));

vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#000' } }));

vi.mock('../../../theme/tokens', () => ({
  spacing: [0, 4, 8, 12, 16, 20],
  sheetStyles: { indicator: {} },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {} }),
}));

import { AngleSelectorSheet } from '../AngleSelectorSheet';

const noop = () => {};

beforeEach(() => {
  stats.calls = [];
});

afterEach(() => {
  cleanup();
});

describe('AngleSelectorSheet — stats-history fetch gating', () => {
  it('does not fetch climb stats while the sheet is closed', () => {
    render(
      createElement(AngleSelectorSheet, {
        visible: false,
        onClose: noop,
        boardName: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-1',
        currentAngle: 40,
        onAngleChange: noop,
      }),
    );

    expect(stats.calls.length).toBeGreaterThan(0);
    // Every call while closed must pass null so the query stays disabled.
    for (const call of stats.calls) {
      expect(call.climbUuid).toBeNull();
    }
  });

  it('fetches the climb stats once the sheet is presented', () => {
    render(
      createElement(AngleSelectorSheet, {
        visible: true,
        onClose: noop,
        boardName: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-1',
        currentAngle: 40,
        onAngleChange: noop,
      }),
    );

    expect(stats.calls.some((call) => call.climbUuid === 'climb-1')).toBe(true);
  });
});
