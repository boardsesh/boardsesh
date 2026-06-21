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
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => `Display:${boardType}`,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000' }, brandColors: { primary: '#6D28D9' } }),
}));

// The reveal badge is its own variant-aware component (paper / reanimated); stub
// it to a marker so the badge-present assertion stays decoupled from its render.
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge-dot': 'true' }) }));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));

type ActionMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};
vi.mock('../GlassActionToolbar', () => ({
  GlassToolbarAction: ({ children, onPress, accessibilityLabel, accessibilityHint }: ActionMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-hint': accessibilityHint ?? '',
        // Tag with the board label only when present, so a board-less render is findable as absent.
        'data-label': accessibilityLabel?.includes('•') ? accessibilityLabel : '',
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));

import { BoardToolbarAction } from '../BoardToolbarAction';

const boardButton = (root: HTMLElement) =>
  root.querySelector('[data-label]:not([data-label=""])') as HTMLButtonElement | null;

const typedBoard: BoardLabelFields = {
  name: '',
  angle: 40,
  boardType: 'kilter',
  sizeName: 'M',
  layoutName: 'Kilter Layout',
};

describe('BoardToolbarAction', () => {
  beforeEach(() => {
    ctrl.board = null;
    haptics.light.mockClear();
  });

  it('renders nothing when there is no active board', () => {
    const { container } = render(createElement(BoardToolbarAction, { onPress: vi.fn() }));
    expect(boardButton(container)).toBeNull();
  });

  it('renders the board glyph labelled with the board and fires onPress with a haptic', () => {
    ctrl.board = typedBoard;
    const onPress = vi.fn();
    const { container } = render(createElement(BoardToolbarAction, { onPress }));
    const button = boardButton(container);
    expect(button?.getAttribute('data-label')).toBe('Display:kilter • M • 40°');
    expect(button?.querySelector('[data-icon="boards"]')).not.toBeNull();
    fireEvent.click(button!);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('forwards the accessibility hint', () => {
    ctrl.board = typedBoard;
    const { container } = render(
      createElement(BoardToolbarAction, { onPress: vi.fn(), accessibilityHint: 'Opens switcher' }),
    );
    expect(boardButton(container)?.getAttribute('data-hint')).toBe('Opens switcher');
  });

  it('renders no onboarding badge by default', () => {
    ctrl.board = typedBoard;
    const { container } = render(createElement(BoardToolbarAction, { onPress: vi.fn() }));
    expect(container.querySelector('[data-badge-dot]')).toBeNull();
  });

  it('renders the onboarding badge when badge is true', () => {
    ctrl.board = typedBoard;
    const { container } = render(createElement(BoardToolbarAction, { onPress: vi.fn(), badge: true }));
    expect(container.querySelector('[data-badge-dot]')).not.toBeNull();
  });
});
