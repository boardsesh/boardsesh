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
  drawn: [] as {
    label: string;
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
    maxWidth?: number;
  }[],
  rowLayouts: [] as Array<(event: { nativeEvent: { layout: { width: number } } }) => void>,
  values: [] as { text: string; color?: string }[],
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    onLayout,
  }: Children & { onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void }) => {
    if (onLayout) menus.rowLayouts.push(onLayout);
    return createElement('div', { 'data-testid': testID }, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: {
    label: string;
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
    maxWidth?: number;
  }) => {
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
vi.mock('../../Text', () => ({
  Text: ({ children, color }: Children & { color?: string }) => {
    if (typeof children === 'string') menus.values.push({ text: children, color });
    return createElement('span', null, children);
  },
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#fff', tertiaryLabel: '#666' } }),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { disabled: 0.5 }, spacing: { 3: 12, 4: 16, 12: 48 } }));

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

  // A long size reads "10×12 · Full Ride": its anchor never runs past the row.
  it("caps the menu's anchor at the row's inner width", async () => {
    menus.drawn = [];
    menus.rowLayouts = [];
    const { act } = await import('@testing-library/react');
    render(
      createElement(BoardSetupRows, {
        rows: [{ label: 'Size', options: options(3, 0), onSelectIndex: vi.fn(), listField: 'size', testID: 'size' }],
        placeholder: 'Choose',
        onOpenList: vi.fn(),
      }),
    );
    expect(menus.drawn.at(-1)?.maxWidth).toBeUndefined();
    act(() => {
      for (const onLayout of menus.rowLayouts) onLayout({ nativeEvent: { layout: { width: 288 } } });
    });
    expect(menus.drawn.at(-1)?.maxWidth).toBe(256);
  });

  it("draws a pushed row's value like a menu anchor: the label colour", () => {
    menus.values = [];
    render(
      createElement(BoardSetupRows, {
        rows: [{ label: 'Size', options: options(10, 4), onSelectIndex: vi.fn(), listField: 'size', testID: 'size' }],
        placeholder: 'Choose',
        onOpenList: vi.fn(),
      }),
    );
    expect(menus.values.find((value) => value.text === 'Option 4')?.color).toBe('#fff');
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
