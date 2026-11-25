// @vitest-environment jsdom
//
// Set up's Board, Layout and Size rows: a native menu up to eight options, the
// pushed checklist past that, and nothing for a row with no options.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AppMenuAction } from '../../AppMenu.types';

type Children = { children?: ReactNode; testID?: string };
const menus = vi.hoisted(() => ({
  drawn: [] as { label: string; actions: AppMenuAction[]; onSelectIndex: (index: number) => void }[],
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: { label: string; actions: AppMenuAction[]; onSelectIndex: (index: number) => void }) => {
    menus.drawn.push(props);
    return createElement('span', { 'data-menu': props.label });
  },
}));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: Children) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {} },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#fff', tertiaryLabel: '#666' } }),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { disabled: 0.5 } }));

const { BoardSetupRows } = await import('../BoardSetupRows');

function options(count: number, selectedIndex: number | null) {
  return Array.from({ length: count }, (_, index) => ({
    key: index,
    label: `Option ${index}`,
    selected: index === selectedIndex,
  }));
}

describe('BoardSetupRows', () => {
  it('opens a menu for up to eight options, reading the picked one', () => {
    menus.drawn = [];
    const onSelectIndex = vi.fn();
    render(
      createElement(BoardSetupRows, {
        rows: [{ label: 'Layout', options: options(8, 2), onSelectIndex, listField: 'layout', testID: 'layout' }],
        placeholder: 'Choose',
        onOpenList: vi.fn(),
      }),
    );
    expect(menus.drawn.at(-1)?.label).toBe('Option 2');
    expect(menus.drawn.at(-1)?.actions.map((action) => action.selected)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    menus.drawn.at(-1)?.onSelectIndex(5);
    expect(onSelectIndex).toHaveBeenCalledExactlyOnceWith(5);
  });

  it('pushes the checklist for nine options or more', () => {
    menus.drawn = [];
    const onOpenList = vi.fn();
    render(
      createElement(BoardSetupRows, {
        rows: [
          { label: 'Size', options: options(10, null), onSelectIndex: vi.fn(), listField: 'size', testID: 'size' },
        ],
        placeholder: 'Choose',
        onOpenList,
      }),
    );
    expect(menus.drawn).toEqual([]);
    expect(screen.getByTestId('size').textContent).toContain('Choose');
    fireEvent.click(screen.getByTestId('size'));
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith('size');
  });

  it('keeps a menu for a long row with no checklist to push (board type)', () => {
    menus.drawn = [];
    render(
      createElement(BoardSetupRows, {
        rows: [{ label: 'Board', options: options(9, 0), onSelectIndex: vi.fn(), testID: 'board' }],
        placeholder: 'Choose',
        onOpenList: vi.fn(),
      }),
    );
    expect(menus.drawn).toHaveLength(1);
  });

  it('leaves out a row with no options, and draws nothing with none at all', () => {
    const { container } = render(
      createElement(BoardSetupRows, {
        rows: [{ label: 'Size', options: [], onSelectIndex: vi.fn(), listField: 'size', testID: 'size' }],
        placeholder: 'Choose',
        onOpenList: vi.fn(),
      }),
    );
    expect(container.innerHTML).toBe('');
  });
});
