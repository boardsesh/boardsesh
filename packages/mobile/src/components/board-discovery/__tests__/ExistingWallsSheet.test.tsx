// @vitest-environment jsdom
//
// The builder's "already has" sheet (#8151). Keep setting up mine acknowledges
// walls, so it only appears once the climber can see some. The walls are the
// sheet's own scrolling list, shelf by shelf, with the choices in its header.
// A near-miss row asks "Is this your wall?" in the same sheet before anything
// is taken.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => createElement('span', { 'data-spinner': true }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children?: ReactNode; header?: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: { title: string; leading: { kind: string; onPress: () => void } }) =>
    createElement('header', null, [
      createElement('h1', { key: 'title' }, title),
      createElement('button', { key: 'leading', 'data-leading': leading.kind, onClick: leading.onPress }),
    ]),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('p', { 'data-testid': testID }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, loading }: { title: string; onPress?: () => void; loading?: boolean }) =>
    createElement('button', { 'data-button': title, 'data-loading': loading === true, onClick: onPress }),
}));
// The sheet's list as its header, then one cell per row, in order.
type SheetListProps = {
  data: { key: string }[];
  renderItem: (info: { item: unknown; index: number }) => ReactNode;
  keyExtractor: (item: never) => string;
  ListHeaderComponent?: ReactNode;
};
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: SheetListProps) =>
    createElement('div', { 'data-list': true }, [
      createElement('div', { key: 'header', 'data-list-header': true }, ListHeaderComponent),
      createElement(
        'ul',
        { key: 'rows', 'data-cells': data.length },
        data.map((item, index) =>
          createElement('li', { key: keyExtractor(item as never) }, renderItem({ item, index })),
        ),
      ),
    ]),
}));
vi.mock('../../gym-page/InsetGroupedCell', () => ({
  InsetGroupedCell: ({ children, position }: { children?: ReactNode; position: string }) =>
    createElement('div', { 'data-position': position }, children),
}));
vi.mock('../BoardRow', () => ({
  BoardRow: ({ item, onPress }: { item: { key: string }; onPress: (item: unknown) => void }) =>
    createElement('button', { 'data-row': item.key, onClick: () => onPress(item) }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

const { ExistingWallsSheet } = await import('../ExistingWallsSheet');

type SheetProps = Parameters<typeof ExistingWallsSheet>[0];
const sameSetupShelf = {
  key: 'same_setup',
  items: [{ key: 'a' }, { key: 'b' }],
} as unknown as SheetProps['shelves'][number];

function renderSheet(overrides: Partial<SheetProps> = {}) {
  const handlers = {
    onUse: vi.fn(),
    onFixSetup: vi.fn(),
    onKeepMine: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
  };
  const rendered = render(
    createElement(ExistingWallsSheet, {
      gymName: 'Boulder Space',
      boardLabel: 'MoonBoard',
      wallCount: 2,
      shelves: [sameSetupShelf],
      fixableKeys: new Set<string>(),
      canKeepMine: true,
      loading: false,
      loadFailed: false,
      busy: false,
      BoardArt: () => null,
      ...handlers,
      ...overrides,
    }),
  );
  return { ...rendered, ...handlers };
}
const rowCount = (container: HTMLElement) => container.querySelectorAll('[data-row]').length;

describe('ExistingWallsSheet', () => {
  it('names the gym and counts the walls with a plural key', () => {
    const { container } = renderSheet();
    expect(container.querySelector('h1')?.textContent).toBe(
      'mobile.create.existingWalls.title {"gym":"Boulder Space","count":2,"board":"MoonBoard"}',
    );
  });

  it('falls back to "this gym" when the gym was auto-attached', () => {
    const { container } = renderSheet({ gymName: null });
    expect(container.querySelector('h1')?.textContent).toContain('mobile.create.existingWalls.titleNoGym');
  });

  it('offers the walls, Use this board and Keep setting up mine once loaded', () => {
    const { container } = renderSheet();
    expect(rowCount(container)).toBe(2);
    // One kind of wall: no shelf title over it.
    expect(container.textContent).not.toContain('mobile.findWall.sameSetup');
    expect(container.querySelector('[data-button="mobile.create.existingWalls.useBoard"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.findWall.retry"]')).toBeNull();
  });

  it('offers only Try again when nothing could be shown', () => {
    const { container, onRetry } = renderSheet({ shelves: [], canKeepMine: false, loadFailed: true });
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).toBeNull();
    (container.querySelector('[data-button="mobile.findWall.retry"]') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('keeps Keep setting up mine for the walls shown when only some failed', () => {
    const { container } = renderSheet({
      shelves: [{ key: 'same_setup', items: [{ key: 'a' }] }] as unknown as SheetProps['shelves'],
      loadFailed: true,
    });
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.findWall.retry"]')).not.toBeNull();
  });

  it('shows no choice while the walls load', () => {
    const { container } = renderSheet({ shelves: [], canKeepMine: false, loading: true });
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).toBeNull();
  });

  // A long list scrolls inside the sheet; the choices stay above it, in reach.
  it('keeps both choices in reach with many walls, and virtualizes the rows', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ key: `w${index}` }));
    const { container, onUse } = renderSheet({
      shelves: [{ key: 'same_setup', items }] as unknown as SheetProps['shelves'],
      wallCount: 30,
    });
    const header = container.querySelector('[data-list-header]');
    expect(header?.querySelector('[data-button="mobile.create.existingWalls.useBoard"]')).not.toBeNull();
    expect(header?.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-cells="30"]')).not.toBeNull();
    expect(container.querySelector('[data-row="w0"]')?.parentElement?.getAttribute('data-position')).toBe('first');
    expect(container.querySelector('[data-row="w29"]')?.parentElement?.getAttribute('data-position')).toBe('last');
    (container.querySelector('[data-row="w12"]') as HTMLButtonElement).click();
    expect(onUse).toHaveBeenCalledWith({ key: 'w12' }, 12, 'same_setup');
  });

  it('ignores row taps while a choice is in flight', () => {
    const { container, onUse } = renderSheet({ busy: true });
    (container.querySelector('[data-row="a"]') as HTMLButtonElement).click();
    expect(onUse).not.toHaveBeenCalled();
  });
});

describe('ExistingWallsSheet near misses', () => {
  const shelves = [
    { key: 'same_setup', items: [{ key: 'exact' }] },
    { key: 'set_up_differently', items: [{ key: 'no-feet' }, { key: 'no-c' }] },
    { key: 'setup_mismatch', items: [{ key: 'seeded-2016' }] },
  ] as unknown as SheetProps['shelves'];
  const row = (container: HTMLElement, key: string) =>
    container.querySelector(`[data-row="${key}"]`) as HTMLButtonElement;
  const button = (container: HTMLElement, title: string) =>
    container.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

  it('draws the shelves as cells of the one scrolling list, each titled, same setup first', () => {
    const { container } = renderSheet({ shelves });
    expect(container.querySelectorAll('[data-list]')).toHaveLength(1);
    const cells = [...container.querySelectorAll('li')].map(
      (cell) => cell.querySelector('[data-row]')?.getAttribute('data-row') ?? cell.textContent,
    );
    expect(cells).toEqual([
      'mobile.findWall.sameSetup',
      'exact',
      'mobile.findWall.setUpDifferently',
      'no-feet',
      'no-c',
      'mobile.create.existingWalls.setupMismatch',
      'seeded-2016',
    ]);
    // Each shelf is its own card.
    expect(row(container, 'no-feet').parentElement?.getAttribute('data-position')).toBe('first');
    expect(row(container, 'no-c').parentElement?.getAttribute('data-position')).toBe('last');
    expect(row(container, 'seeded-2016').parentElement?.getAttribute('data-position')).toBe('only');
  });

  it('takes a same-setup wall straight away', () => {
    const { container, onUse } = renderSheet({ shelves });
    fireEvent.click(row(container, 'exact'));
    expect(onUse).toHaveBeenCalledWith({ key: 'exact' }, 0, 'same_setup');
  });

  it('asks "Is this your wall?" for a near miss, and uses it as it is', () => {
    const { container, onUse } = renderSheet({ shelves });
    fireEvent.click(row(container, 'no-c'));
    expect(onUse).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe('mobile.create.existingWalls.choiceTitle');
    expect(container.querySelector('[data-leading="back"]')).not.toBeNull();
    // The walls are gone while the question is up, and the wall asked about
    // is words, not a row to tap.
    expect(button(container, 'mobile.create.existingWalls.keepMine')).toBeNull();
    expect(container.querySelector('[data-row]')).toBeNull();
    fireEvent.click(button(container, 'mobile.create.existingWalls.choiceUseAsIs')!);
    expect(onUse).toHaveBeenCalledWith({ key: 'no-c' }, 1, 'set_up_differently');
  });

  it('offers to fix the setup only on a wall the climber may report', () => {
    const fixable = renderSheet({ shelves, fixableKeys: new Set(['seeded-2016']) });
    fireEvent.click(row(fixable.container, 'seeded-2016'));
    fireEvent.click(button(fixable.container, 'mobile.create.existingWalls.choiceFixSetup')!);
    expect(fixable.onFixSetup).toHaveBeenCalledWith({ key: 'seeded-2016' }, 0, 'setup_mismatch');
    fixable.unmount();

    const own = renderSheet({ shelves });
    fireEvent.click(row(own.container, 'seeded-2016'));
    expect(button(own.container, 'mobile.create.existingWalls.choiceFixSetup')).toBeNull();
  });

  it('spins only the answer that was tapped', () => {
    const view = renderSheet({ shelves, fixableKeys: new Set(['no-feet']) });
    fireEvent.click(row(view.container, 'no-feet'));
    fireEvent.click(button(view.container, 'mobile.create.existingWalls.choiceFixSetup')!);
    view.rerender(
      createElement(ExistingWallsSheet, {
        gymName: 'Boulder Space',
        boardLabel: 'MoonBoard',
        wallCount: 2,
        shelves,
        fixableKeys: new Set(['no-feet']),
        canKeepMine: true,
        loading: false,
        loadFailed: false,
        busy: true,
        BoardArt: () => null,
        onUse: view.onUse,
        onFixSetup: view.onFixSetup,
        onKeepMine: view.onKeepMine,
        onRetry: view.onRetry,
        onDismiss: view.onDismiss,
      }),
    );
    expect(button(view.container, 'mobile.create.existingWalls.choiceFixSetup')?.getAttribute('data-loading')).toBe(
      'true',
    );
    expect(button(view.container, 'mobile.create.existingWalls.choiceUseAsIs')?.getAttribute('data-loading')).toBe(
      'false',
    );
  });

  it('goes back to the walls on "No, it\'s a different wall", taking nothing', () => {
    const { container, onUse, onFixSetup } = renderSheet({ shelves, fixableKeys: new Set(['no-feet']) });
    fireEvent.click(row(container, 'no-feet'));
    fireEvent.click(button(container, 'mobile.create.existingWalls.choiceDifferent')!);
    expect(container.querySelector('h1')?.textContent).toContain('mobile.create.existingWalls.title');
    expect(button(container, 'mobile.create.existingWalls.keepMine')).not.toBeNull();
    expect(onUse).not.toHaveBeenCalled();
    expect(onFixSetup).not.toHaveBeenCalled();
  });

  it('offers Use this board only when a wall has the same setup', () => {
    const { container } = renderSheet({ shelves: shelves.slice(1) });
    expect(button(container, 'mobile.create.existingWalls.useBoard')).toBeNull();
    expect(button(container, 'mobile.create.existingWalls.keepMine')).not.toBeNull();
  });
});
