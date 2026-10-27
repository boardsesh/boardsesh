// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type BoardLabelFields = Pick<UserBoard, 'name' | 'angle' | 'boardType' | 'sizeName' | 'layoutName'> & {
  isAngleAdjustable?: boolean;
};

const ctrl = vi.hoisted(() => ({ board: null as BoardLabelFields | null }));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => `Display:${boardType}`,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#888', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

// The reveal badge is its own variant-aware component (paper / reanimated); stub
// it to a marker so the badge-present assertion stays decoupled from its render.
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge-dot': 'true' }) }));

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

const renderSwitcher = (props: Partial<{ onPress: () => void; accessibilityHint: string; badge: boolean }> = {}) =>
  render(createElement(BoardSwitcherButton, { title: 'Discover', onPress: vi.fn(), ...props }));

describe('BoardSwitcherButton', () => {
  beforeEach(() => {
    ctrl.board = null;
    haptics.light.mockClear();
  });

  it('shows the screen title alone, not as a button, when there is no active board', () => {
    const { container } = renderSwitcher();
    expect(button(container)).toBeNull();
    expect(container.textContent).toBe('Discover');
    expect(container.querySelector('[data-icon="chevron.down"]')).toBeNull();
  });

  it('puts the board (angle omitted) under the title with a caret and fires onPress with a haptic', () => {
    ctrl.board = typedBoard;
    const onPress = vi.fn();
    const { container } = renderSwitcher({ onPress });
    const target = button(container);
    // An adjustable board's angle rides its own control, so the subtitle omits "• 40°".
    expect(target?.getAttribute('data-label')).toBe('Discover, Display:kilter • M');
    expect(container.textContent).toContain('Discover');
    expect(container.textContent).toContain('Display:kilter • M');
    expect(container.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    fireEvent.click(target!);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('keeps the angle for a fixed-angle wall, which has no angle control', () => {
    ctrl.board = { ...typedBoard, isAngleAdjustable: false };
    const { container } = renderSwitcher();
    expect(button(container)?.getAttribute('data-label')).toBe('Discover, Display:kilter • M • 40°');
  });

  it('leads with the custom board name for a named board (angle omitted)', () => {
    ctrl.board = namedBoard;
    const { container } = renderSwitcher();
    expect(button(container)?.getAttribute('data-label')).toBe('Discover, Garage Wall');
  });

  it('renders a named board with no angle', () => {
    ctrl.board = namedBoardNoAngle;
    const { container } = renderSwitcher();
    expect(button(container)?.getAttribute('data-label')).toBe('Discover, Garage Wall');
  });

  it('forwards the accessibility hint', () => {
    ctrl.board = typedBoard;
    const { container } = renderSwitcher({ accessibilityHint: 'Opens the board switcher' });
    expect(button(container)?.getAttribute('data-hint')).toBe('Opens the board switcher');
  });

  it('renders no onboarding badge by default', () => {
    ctrl.board = typedBoard;
    const { container } = renderSwitcher();
    expect(container.querySelector('[data-badge-dot]')).toBeNull();
  });

  it('renders the onboarding badge when badge is true', () => {
    ctrl.board = typedBoard;
    const { container } = renderSwitcher({ badge: true });
    expect(container.querySelector('[data-badge-dot]')).not.toBeNull();
  });
});
