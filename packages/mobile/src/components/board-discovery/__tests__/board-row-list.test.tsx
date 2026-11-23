// @vitest-environment jsdom
//
// The picker's board lists: a long list shows its first rows and Show all,
// always with the board you're on (and any row it must keep) in view, and a
// pick or a menu row reports the row's place as drawn.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardCardMenu, DiscoveryBoardItem } from '../BoardDiscoveryCardView';

type Children = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: <T,>(styles: T): T => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      key === 'mobile.inRange.showAll' ? `Show all ${params?.count ?? 0} boards` : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', accent: '#ACCENT' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: Children) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {}, leading: {}, text: {} },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: Children & { onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
// A row as a button, and its menu's Details as a second one.
vi.mock('../BoardRow', () => ({
  BoardRow: ({
    item,
    onPress,
    menu,
  }: {
    item: DiscoveryBoardItem;
    onPress: (item: DiscoveryBoardItem) => void;
    menu?: BoardCardMenu;
  }) =>
    createElement(
      'div',
      null,
      createElement('button', { type: 'button', onClick: () => onPress(item) }, item.title),
      menu
        ? createElement(
            'button',
            { type: 'button', onClick: () => menu.onAction(item, 'details', 'menu_button') },
            `Details ${item.title}`,
          )
        : null,
    ),
}));

const { BoardRowList } = await import('../BoardRowList');

const BOARDS: DiscoveryBoardItem[] = Array.from({ length: 9 }, (_unused, index) => ({
  key: `board-${index + 1}`,
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  title: `Board ${index + 1}`,
  isActive: index === 7,
}));
const CAPABILITIES = { canPin: true, canDownload: true, canOpenDetails: true, canManage: true, canReport: false };

function shownTitles(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((title) => /^Board \d+$/.test(title));
}

afterEach(cleanup);

describe('BoardRowList', () => {
  it('shows every row when it is not collapsible', () => {
    render(<BoardRowList items={BOARDS} onSelect={vi.fn()} BoardArt={() => null} />);
    expect(shownTitles()).toHaveLength(9);
  });

  // Your boards: the first six, with the board you're on in view.
  it('shows the first rows and the board you are on, then all after Show all', () => {
    render(<BoardRowList items={BOARDS} onSelect={vi.fn()} collapsedRowCount={6} BoardArt={() => null} />);
    expect(shownTitles()).toEqual(['Board 1', 'Board 2', 'Board 3', 'Board 4', 'Board 5', 'Board 8']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 boards' }));
    expect(shownTitles()).toHaveLength(9);
  });

  it('keeps the rows it is asked to keep in view', () => {
    render(
      <BoardRowList
        items={BOARDS}
        onSelect={vi.fn()}
        collapsedRowCount={4}
        alwaysShownKeys={new Set(['board-6'])}
        BoardArt={() => null}
      />,
    );
    expect(shownTitles()).toEqual(['Board 1', 'Board 2', 'Board 6', 'Board 8']);
  });

  // The row's place as the climber saw it, not in the full list.
  it('reports a pick and a menu row at their place as drawn', () => {
    const onSelect = vi.fn();
    const onMenuAction = vi.fn();
    render(
      <BoardRowList
        items={BOARDS}
        onSelect={onSelect}
        menuCapabilities={CAPABILITIES}
        onMenuAction={onMenuAction}
        collapsedRowCount={6}
        BoardArt={() => null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Board 8' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(BOARDS[7], 5);
    fireEvent.click(screen.getByRole('button', { name: 'Details Board 8' }));
    expect(onMenuAction).toHaveBeenCalledExactlyOnceWith(BOARDS[7], 'details', 'menu_button', 5);
  });

  it('gives the menu only to the rows it names', () => {
    render(
      <BoardRowList
        items={BOARDS.slice(0, 3)}
        onSelect={vi.fn()}
        menuCapabilities={CAPABILITIES}
        onMenuAction={vi.fn()}
        menuKeys={new Set(['board-2'])}
        BoardArt={() => null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Details Board 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Details Board 2' })).toBeTruthy();
  });
});
