// @vitest-environment jsdom
//
// The builder's "already has" sheet (#8151). Keep setting up mine acknowledges
// walls, so it only appears once the climber can see some.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
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
  SheetTopBar: ({ title }: { title: string }) => createElement('h1', null, title),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }),
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
        { key: 'rows', 'data-rows': data.length },
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
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

const { ExistingWallsSheet } = await import('../ExistingWallsSheet');

function renderSheet(overrides: Partial<Parameters<typeof ExistingWallsSheet>[0]> = {}) {
  const handlers = { onUse: vi.fn(), onKeepMine: vi.fn(), onRetry: vi.fn(), onDismiss: vi.fn() };
  const rendered = render(
    createElement(ExistingWallsSheet, {
      gymName: 'Boulder Space',
      boardLabel: 'MoonBoard',
      wallCount: 2,
      items: [{ key: 'a' }, { key: 'b' }] as never[],
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
    expect(container.querySelector('[data-rows="2"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.create.existingWalls.useBoard"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.findWall.retry"]')).toBeNull();
  });

  it('offers only Try again when nothing could be shown', () => {
    const { container, onRetry } = renderSheet({ items: [], loadFailed: true });
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).toBeNull();
    (container.querySelector('[data-button="mobile.findWall.retry"]') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('keeps Keep setting up mine for the walls shown when only some failed', () => {
    const { container } = renderSheet({ items: [{ key: 'a' }] as never[], loadFailed: true });
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.findWall.retry"]')).not.toBeNull();
  });

  it('shows no choice while the walls load', () => {
    const { container } = renderSheet({ items: [], loading: true });
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(container.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).toBeNull();
  });

  // A long list scrolls inside the sheet; the choices stay above it, in reach.
  it('keeps both choices in reach with many walls, and virtualizes the rows', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ key: `w${index}` })) as never[];
    const { container, onUse } = renderSheet({ items, wallCount: 30 });
    const header = container.querySelector('[data-list-header]');
    expect(header?.querySelector('[data-button="mobile.create.existingWalls.useBoard"]')).not.toBeNull();
    expect(header?.querySelector('[data-button="mobile.create.existingWalls.keepMine"]')).not.toBeNull();
    expect(container.querySelector('[data-rows="30"]')).not.toBeNull();
    expect(container.querySelector('[data-row="w0"]')?.parentElement?.getAttribute('data-position')).toBe('first');
    expect(container.querySelector('[data-row="w29"]')?.parentElement?.getAttribute('data-position')).toBe('last');
    (container.querySelector('[data-row="w12"]') as HTMLButtonElement).click();
    expect(onUse).toHaveBeenCalledWith({ key: 'w12' }, 12);
  });

  it('ignores row taps while a choice is in flight', () => {
    const { container, onUse } = renderSheet({ busy: true });
    (container.querySelector('[data-row="a"]') as HTMLButtonElement).click();
    expect(onUse).not.toHaveBeenCalled();
  });
});
