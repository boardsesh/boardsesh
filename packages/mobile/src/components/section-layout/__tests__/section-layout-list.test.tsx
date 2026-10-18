// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const listProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null, announce: vi.fn() }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: listProps.announce },
  Platform: { OS: 'web' },
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    ...rest
  }: {
    data: Array<{ id: string }>;
    renderItem: (entry: { item: { id: string }; index: number }) => ReactNode;
    keyExtractor: (item: { id: string }) => string;
  }) => {
    listProps.last = rest;
    return createElement(
      'ul',
      null,
      ...data.map((item, index) => createElement('li', { key: keyExtractor(item) }, renderItem({ item, index }))),
    );
  },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const haptics = vi.hoisted(() => ({ selection: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: 'brand' },
    systemColors: { tertiaryLabel: 'tertiary', secondaryBackground: 'surface', separator: 'separator' },
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    // Fires even when disabled, so the row's own refusal is what these tests see.
    createElement(
      'button',
      { onClick: onPress, 'data-disabled': String(Boolean(disabled)), 'data-testid': testID },
      children,
    ),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
    disabled,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled: boolean;
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));

import { placeSectionLayoutRows, SectionLayoutList, type SectionLayoutRowModel } from '../SectionLayoutList';

type Id = 'activeHolds' | 'logbook' | 'community' | 'feed';
const ROWS: SectionLayoutRowModel<Id>[] = [
  { id: 'activeHolds', label: 'Active holds', visible: false, movable: false },
  { id: 'logbook', label: 'Logbook', visible: true, movable: true },
  { id: 'community', label: 'Community', visible: false, movable: true },
  { id: 'feed', label: 'Feed', visible: true, movable: false },
];

afterEach(() => {
  cleanup();
  listProps.announce.mockClear();
  haptics.selection.mockClear();
});

describe('placeSectionLayoutRows', () => {
  it('groups switch-only rows apart from the rows with arrows', () => {
    expect(
      placeSectionLayoutRows(ROWS).map(({ id, first, last, gapAbove, position, canMoveUp, canMoveDown }) => ({
        id,
        first,
        last,
        gapAbove,
        position,
        canMoveUp,
        canMoveDown,
      })),
    ).toEqual([
      {
        id: 'activeHolds',
        first: true,
        last: true,
        gapAbove: false,
        position: 0,
        canMoveUp: false,
        canMoveDown: false,
      },
      { id: 'logbook', first: true, last: false, gapAbove: true, position: 1, canMoveUp: false, canMoveDown: true },
      { id: 'community', first: false, last: true, gapAbove: false, position: 2, canMoveUp: true, canMoveDown: false },
      { id: 'feed', first: true, last: true, gapAbove: true, position: 0, canMoveUp: false, canMoveDown: false },
    ]);
    expect(placeSectionLayoutRows(ROWS).every((row) => row.movableCount === 2)).toBe(true);
  });
});

describe('SectionLayoutList', () => {
  it('draws arrows only on rows that can move, and reports switches and moves by id', () => {
    const onVisibleChange = vi.fn();
    const onMove = vi.fn();
    const screen = render(createElement(SectionLayoutList<Id>, { rows: ROWS, onVisibleChange, onMove }));
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.container.querySelectorAll('[data-icon="arrow.up"]')).toHaveLength(2);
    expect(screen.queryByTestId('section-layout-move-up-activeHolds')).toBeNull();
    expect(screen.queryByTestId('section-layout-move-down-feed')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Active holds' }));
    fireEvent.click(screen.getByTestId('section-layout-move-down-logbook'));
    expect(onVisibleChange).toHaveBeenCalledWith('activeHolds', true);
    expect(onMove).toHaveBeenCalledWith('logbook', 1);
  });

  it('greys every switch and arrow out while disabled', () => {
    const screen = render(
      createElement(SectionLayoutList<Id>, { rows: ROWS, disabled: true, onVisibleChange: vi.fn(), onMove: vi.fn() }),
    );
    const switches = [...screen.container.querySelectorAll('input')] as HTMLInputElement[];
    const arrows = [...screen.container.querySelectorAll('button')];
    expect(switches.every((control) => control.disabled)).toBe(true);
    expect(arrows.length).toBe(4);
    expect(arrows.every((arrow) => arrow.getAttribute('data-disabled') === 'true')).toBe(true);
  });

  it('refuses a move past the end or while disabled: no move, nothing said', () => {
    const onMove = vi.fn();
    const enabled = render(createElement(SectionLayoutList<Id>, { rows: ROWS, onVisibleChange: vi.fn(), onMove }));
    fireEvent.click(enabled.getByTestId('section-layout-move-up-logbook'));
    fireEvent.click(enabled.getByTestId('section-layout-move-down-community'));
    cleanup();
    const disabled = render(
      createElement(SectionLayoutList<Id>, { rows: ROWS, disabled: true, onVisibleChange: vi.fn(), onMove }),
    );
    fireEvent.click(disabled.getByTestId('section-layout-move-down-logbook'));
    expect(onMove).not.toHaveBeenCalled();
    expect(listProps.announce).not.toHaveBeenCalled();
  });

  it('stays quiet when the handler refuses the move', () => {
    const onMove = vi.fn(() => false);
    const screen = render(createElement(SectionLayoutList<Id>, { rows: ROWS, onVisibleChange: vi.fn(), onMove }));
    fireEvent.click(screen.getByTestId('section-layout-move-down-logbook'));
    expect(onMove).toHaveBeenCalledWith('logbook', 1);
    expect(listProps.announce).not.toHaveBeenCalled();
    expect(haptics.selection).not.toHaveBeenCalled();
  });

  it('says where a moved section landed', () => {
    const onMove = vi.fn();
    const screen = render(createElement(SectionLayoutList<Id>, { rows: ROWS, onVisibleChange: vi.fn(), onMove }));
    fireEvent.click(screen.getByTestId('section-layout-move-down-logbook'));
    expect(onMove).toHaveBeenCalledWith('logbook', 1);
    expect(listProps.announce).toHaveBeenCalledWith('mobile.settings.sectionLayout.moved');
  });

  it('hands every other list prop to the list, so callers never edit this component', () => {
    render(
      createElement(SectionLayoutList<Id>, {
        rows: ROWS,
        onVisibleChange: vi.fn(),
        onMove: vi.fn(),
        testID: 'customize-home-list',
        contentInsetAdjustmentBehavior: 'automatic',
        showsVerticalScrollIndicator: true,
      }),
    );
    expect(listProps.last).toMatchObject({
      testID: 'customize-home-list',
      contentInsetAdjustmentBehavior: 'automatic',
      showsVerticalScrollIndicator: true,
    });
  });
});
