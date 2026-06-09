// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type BoardLabelFields = Pick<UserBoard, 'name' | 'angle' | 'boardType' | 'sizeName' | 'layoutName'>;

const ctrl = vi.hoisted(() => ({ board: null as BoardLabelFields | null }));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => `Display:${boardType}`,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', secondaryLabel: '#888', fill: '#eee' } }),
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12 } }));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, accessibilityHint }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-hint': accessibilityHint ?? '',
        // Always pass the label through (don't gate on the "•" separator): a
        // named board with no angle has no bullet, and gating would make the
        // button() helper silently return null and false-pass.
        'data-label': accessibilityLabel ?? '',
      },
      children,
    ),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));

import { BoardSwitcherButton } from '../BoardSwitcherButton';

const button = (root: HTMLElement) =>
  root.querySelector('[data-label]:not([data-label=""])') as HTMLButtonElement | null;

const typedBoard: BoardLabelFields = {
  name: '',
  angle: 40,
  boardType: 'kilter',
  sizeName: 'M',
  layoutName: 'Kilter Layout',
};
const namedBoard: BoardLabelFields = {
  name: 'Garage Wall',
  angle: 25,
  boardType: 'tension',
  sizeName: '8x10',
  layoutName: 'Tension Layout',
};
const namedBoardNoAngle: BoardLabelFields = {
  name: 'Garage Wall',
  angle: null as unknown as number,
  boardType: 'tension',
  sizeName: '8x10',
  layoutName: 'Tension Layout',
};

describe('BoardSwitcherButton', () => {
  beforeEach(() => {
    ctrl.board = null;
    haptics.light.mockClear();
  });

  it('renders nothing when there is no active board', () => {
    const { container } = render(createElement(BoardSwitcherButton, { onPress: vi.fn() }));
    expect(button(container)).toBeNull();
  });

  it('renders the board label with a caret and fires onPress with a haptic', () => {
    ctrl.board = typedBoard;
    const onPress = vi.fn();
    const { container } = render(createElement(BoardSwitcherButton, { onPress }));
    const target = button(container);
    expect(target?.getAttribute('data-label')).toBe('Display:kilter • M • 40°');
    expect(container.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    fireEvent.click(target!);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('leads with the custom board name for a named board', () => {
    ctrl.board = namedBoard;
    const { container } = render(createElement(BoardSwitcherButton, { onPress: vi.fn() }));
    expect(button(container)?.getAttribute('data-label')).toBe('Garage Wall • 25°');
  });

  it('renders a named board with no angle (label has no separator)', () => {
    ctrl.board = namedBoardNoAngle;
    const { container } = render(createElement(BoardSwitcherButton, { onPress: vi.fn() }));
    expect(button(container)?.getAttribute('data-label')).toBe('Garage Wall');
  });

  it('forwards the accessibility hint', () => {
    ctrl.board = typedBoard;
    const { container } = render(
      createElement(BoardSwitcherButton, { onPress: vi.fn(), accessibilityHint: 'Opens the board switcher' }),
    );
    expect(button(container)?.getAttribute('data-hint')).toBe('Opens the board switcher');
  });
});
