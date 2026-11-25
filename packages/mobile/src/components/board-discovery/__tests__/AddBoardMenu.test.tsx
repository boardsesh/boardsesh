// @vitest-environment jsdom
//
// The + in the picker's and Manage boards' top bar. AppMenu hands back an index,
// so the rows it draws and ADD_BOARD_MENU_KINDS must stay in the same order, or a
// tap on "Add a Spraywall" would open the builder.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import type { AppMenuAction } from '../../AppMenu.types';

type MenuProps = {
  iconName: string;
  iconAppearance?: string;
  anchorSize?: number;
  accessibilityLabel: string;
  actions: AppMenuAction[];
  onSelectIndex: (index: number) => void;
};
const menu = vi.hoisted(() => ({ last: null as MenuProps | null }));

vi.mock('../../AppMenu', () => ({
  AppMenu: (props: MenuProps) => {
    menu.last = props;
    return null;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        ) ?? key,
  }),
}));
const theme = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: theme.variant }) }));

const { ADD_BOARD_MENU_KINDS, GYM_FIRST_ADD_BOARD_MENU_ROWS, AddBoardMenu } = await import('../AddBoardMenu');

function renderedMenu(): MenuProps {
  if (!menu.last) throw new Error('AddBoardMenu drew no AppMenu');
  return menu.last;
}

beforeEach(() => {
  menu.last = null;
  theme.variant = 'liquidGlass';
});

describe('AddBoardMenu', () => {
  it('draws a + with the three ways to add a board, the gym map after a divider', () => {
    render(<AddBoardMenu onSelect={vi.fn()} />);
    const { iconName, accessibilityLabel, actions } = renderedMenu();

    expect(iconName).toBe('plus');
    expect(accessibilityLabel).toBe('Add a board');
    expect(actions.map((action) => action.label)).toEqual(['Set up a board', 'Add a Spraywall', 'Find a gym']);
    expect(actions.map((action) => action.dividerBefore === true)).toEqual([false, false, true]);
  });

  it('keeps the kinds in the order the rows are drawn', () => {
    expect(ADD_BOARD_MENU_KINDS).toEqual(['board', 'spraywall', 'gym_map']);
    render(<AddBoardMenu onSelect={vi.fn()} />);
    expect(renderedMenu().actions).toHaveLength(ADD_BOARD_MENU_KINDS.length);
  });

  it.each([
    { index: 0, kind: 'board' },
    { index: 1, kind: 'spraywall' },
    { index: 2, kind: 'gym_map' },
  ])('hands row $index on as $kind', ({ index, kind }) => {
    const onSelect = vi.fn();
    render(<AddBoardMenu onSelect={onSelect} />);
    renderedMenu().onSelectIndex(index);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(kind);
  });

  it('runs nothing for an index past the rows', () => {
    const onSelect = vi.fn();
    render(<AddBoardMenu onSelect={onSelect} />);
    renderedMenu().onSelectIndex(3);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // #8151: with the gym-first flag, the builder row splits so a gym wall
  // somebody already added is found before it is added again.
  describe('gym-first', () => {
    it('splits Set up a board into My own board and A board at my gym', () => {
      render(<AddBoardMenu onSelect={vi.fn()} gymFirst />);
      const { actions } = renderedMenu();
      expect(actions.map((action) => action.label)).toEqual([
        'My own board',
        'A board at my gym',
        'Add a Spraywall',
        'Find a gym',
      ]);
      expect(actions.map((action) => action.dividerBefore === true)).toEqual([false, false, false, true]);
      expect(actions).toHaveLength(GYM_FIRST_ADD_BOARD_MENU_ROWS.length);
    });

    it.each([
      { index: 0, args: ['board', 'home'] },
      { index: 1, args: ['board', 'gym'] },
      { index: 2, args: ['spraywall'] },
      { index: 3, args: ['gym_map'] },
    ])('hands row $index on as $args', ({ index, args }) => {
      const onSelect = vi.fn();
      render(<AddBoardMenu onSelect={onSelect} gymFirst />);
      renderedMenu().onSelectIndex(index);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(...args);
    });

    it('keeps the single row when the flag is off', () => {
      render(<AddBoardMenu onSelect={vi.fn()} gymFirst={false} />);
      expect(renderedMenu().actions[0]?.label).toBe('Set up a board');
    });
  });

  // The native bar's own frame: UIKit draws the glass around it on Liquid
  // Glass, and Material's top app bar takes the whole 48 dp target.
  it.each([
    { variant: 'liquidGlass', anchorSize: 32 },
    { variant: 'material', anchorSize: 48 },
  ] as const)('sizes the + to the $variant native bar', ({ variant, anchorSize }) => {
    theme.variant = variant;
    render(<AddBoardMenu onSelect={vi.fn()} />);
    expect(renderedMenu().anchorSize).toBe(anchorSize);
    expect(renderedMenu().iconAppearance).toBe('plain');
  });
});
