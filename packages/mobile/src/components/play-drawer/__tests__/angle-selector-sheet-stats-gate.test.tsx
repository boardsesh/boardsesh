// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styleSheet: unknown) => styleSheet,
  },
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

vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));

type TopBarAction = { label?: string; kind?: string; onPress: () => void };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading, trailing }: { title: string; leading?: TopBarAction; trailing?: TopBarAction }) =>
    createElement(
      'div',
      null,
      title,
      leading ? createElement('button', { onClick: leading.onPress, 'aria-label': `leading-${leading.kind}` }) : null,
      trailing ? createElement('button', { onClick: trailing.onPress, 'aria-label': trailing.label }) : null,
    ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('@boardsesh/board-config', () => {
  const angles: Record<string, number[]> = { kilter: [20, 25, 30, 40] };
  return {
    ANGLES: angles,
    getBoardAngleOptions: (boardName: string) => angles[boardName] ?? [],
    MOONBOARD_ANGLES: [25, 40],
  };
});

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v_grade' }),
}));

const angleStats = vi.hoisted(() => ({
  map: new Map<number, { quality: number; sends: number; gradeName?: string; color?: string }>(),
}));

vi.mock('../community-utils', () => ({
  buildAngleStatsMap: () => angleStats.map,
}));

vi.mock('../AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));

vi.mock('../AngleSlider', () => ({ AngleSlider: () => null }));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));

vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#000' } }));

vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: [0, 4, 8, 12, 16, 20],
  sheetStyles: { indicator: {} },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: {} }),
}));

import { AngleSelectorSheet } from '../AngleSelectorSheet';

const noop = () => {};

beforeEach(() => {
  stats.calls = [];
  angleStats.map = new Map();
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

// Regression for #3784: the angle preview's star row rendered unconditionally,
// so any angle without community rating data (or a stats row with quality 0)
// showed five hollow stars next to the real min-rating filter in
// ClimbFilterSheet, reading as a second, broken-looking rating control. The
// star row must only render once there is a meaningful (> 0) quality value.
describe('AngleSelectorSheet — star row quality gating', () => {
  it('hides the star row when there is no stats entry for the selected angle', () => {
    const { container } = render(
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

    expect(container.textContent).not.toContain('★');
    expect(container.textContent).not.toContain('☆');
  });

  it('hides the star row when stats exist but quality is 0', () => {
    angleStats.map.set(40, { quality: 0, sends: 12 });

    const { container } = render(
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

    expect(container.textContent).not.toContain('★');
    expect(container.textContent).not.toContain('☆');
  });

  it('shows the star row once the selected angle has a meaningful quality', () => {
    angleStats.map.set(40, { quality: 3.5, sends: 12 });

    const { container } = render(
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

    expect(container.textContent).toContain('★');
    expect(container.textContent).toContain('☆');
  });
});
