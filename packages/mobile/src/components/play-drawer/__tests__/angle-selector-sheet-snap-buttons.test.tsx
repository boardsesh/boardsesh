// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/graphql/hooks', () => ({
  useClimbStatsHistory: () => ({ data: undefined }),
}));

// Heavy UI / native deps stubbed so the component renders under jsdom.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    style?: unknown;
  }) => {
    // Resolve function styles so the pressed-state callback still runs.
    if (typeof style === 'function') style({ pressed: false });
    return createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children);
  },
  StyleSheet: { create: (styleSheet: unknown) => styleSheet },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

// Isolate the sheet from the presentation coordinator (its serialization is
// covered by sheet-presentation-provider.test.tsx).
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
  useTranslation: () => ({
    t: (key: string, options?: { angle?: number }) => (options?.angle == null ? key : `${key}:${options.angle}`),
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('@boardsesh/board-config', () => ({ MOONBOARD_ANGLES: [25, 40] }));

const angleOptions = vi.hoisted(() => ({ angles: [] as number[] }));

vi.mock('../../../hooks/use-board-angle-options', () => ({
  useBoardAngleOptions: () => angleOptions.angles,
}));

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
  spacing: [0, 4, 8, 12, 16, 20],
  sheetStyles: { indicator: {} },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {} }),
}));

import { AngleSelectorSheet } from '../AngleSelectorSheet';

const noop = () => {};
const SNAP_25 = 'mobile.angleSelector.snapToAngle:25';
const SNAP_40 = 'mobile.angleSelector.snapToAngle:40';

function renderSheet(boardName: string, onAngleChange: (angle: number) => void = noop, onClose: () => void = noop) {
  return render(
    createElement(AngleSelectorSheet, {
      visible: true,
      onClose,
      boardName,
      layoutId: 3,
      climbUuid: 'climb-1',
      currentAngle: 30,
      onAngleChange,
    }),
  );
}

beforeEach(() => {
  angleStats.map = new Map();
  angleOptions.angles = [0, 10, 20, 25, 30, 35, 40, 45, 50];
});

afterEach(() => {
  cleanup();
});

// Moon grades every problem at 25° and 40°. On the wide MoonBoard angle range
// those two get one-tap buttons that set the previewed angle (Done applies it).
describe('AngleSelectorSheet — MoonBoard 25°/40° snap buttons', () => {
  it('shows both snap buttons on the wide MoonBoard range', () => {
    renderSheet('moonboard');
    expect(screen.getByLabelText(SNAP_25)).toBeTruthy();
    expect(screen.getByLabelText(SNAP_40)).toBeTruthy();
  });

  it('snaps the preview to 40° and applies it on Done', () => {
    const onAngleChange = vi.fn();
    const { container } = renderSheet('moonboard', onAngleChange);

    fireEvent.click(screen.getByLabelText(SNAP_40));
    expect(container.textContent).toContain('40°');
    // Snapping alone doesn't move the board.
    expect(onAngleChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('actions.done'));
    expect(onAngleChange).toHaveBeenCalledWith(40);
  });

  it('closes from the top bar without applying the previewed angle', () => {
    const onAngleChange = vi.fn();
    const onClose = vi.fn();
    renderSheet('moonboard', onAngleChange, onClose);

    fireEvent.click(screen.getByLabelText(SNAP_40));
    fireEvent.click(screen.getByLabelText('leading-close'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAngleChange).not.toHaveBeenCalled();
  });

  it('hides the buttons when MoonBoard only offers 25° and 40°', () => {
    angleOptions.angles = [25, 40];
    renderSheet('moonboard');
    expect(screen.queryByLabelText(SNAP_25)).toBeNull();
  });

  it('hides the buttons on other boards', () => {
    renderSheet('kilter');
    expect(screen.queryByLabelText(SNAP_25)).toBeNull();
    expect(screen.queryByLabelText(SNAP_40)).toBeNull();
  });
});
