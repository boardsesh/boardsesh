import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryBoardItem } from '../../../components/board-discovery/BoardDiscoveryCardView';

vi.mock('@boardsesh/board-config', () => ({ stripGymNamePrefix: (name: string) => name }));

const { gymWallListItems } = await import('../gym-wall-list-items');

function walls(prefix: string, count: number): DiscoveryBoardItem[] {
  return Array.from({ length: count }, (_, index) => ({ key: `${prefix}${index}` }) as DiscoveryBoardItem);
}

function shape(cells: ReturnType<typeof gymWallListItems>) {
  return cells.map((cell) =>
    cell.kind === 'wall' ? `wall:${cell.item.key}:${cell.position}:${cell.index}` : `${cell.kind}:${cell.key}`,
  );
}

describe('gymWallListItems', () => {
  it('draws a header, then each wall as a slice of one card', () => {
    expect(shape(gymWallListItems([{ key: 'at_gym', title: 'At Crux', items: walls('a', 3) }], new Set(), 5))).toEqual([
      'header:header:at_gym',
      'wall:a0:first:0',
      'wall:a1:middle:1',
      'wall:a2:last:2',
    ]);
  });

  it('collapses a long shelf to five rows and closes its card with Show all', () => {
    const cells = gymWallListItems([{ key: 'at_gym', title: 'At Crux', items: walls('a', 8) }], new Set(), 5);
    expect(shape(cells).slice(-2)).toEqual(['wall:a4:middle:4', 'showAll:showAll:at_gym']);
    const showAll = cells.at(-1);
    expect(showAll).toMatchObject({ kind: 'showAll', count: 8, position: 'last' });
  });

  it('keeps a shelf with one row to spare whole, rather than hiding one behind Show all', () => {
    const cells = gymWallListItems([{ key: 'at_gym', title: 'At Crux', items: walls('a', 6) }], new Set(), 5);
    expect(cells.filter((cell) => cell.kind === 'wall')).toHaveLength(6);
    expect(cells.some((cell) => cell.kind === 'showAll')).toBe(false);
  });

  it('shows every row of an expanded shelf', () => {
    const cells = gymWallListItems([{ key: 'at_gym', title: 'At Crux', items: walls('a', 8) }], new Set(['at_gym']), 5);
    expect(cells.filter((cell) => cell.kind === 'wall')).toHaveLength(8);
    expect(cells.at(-1)).toMatchObject({ kind: 'wall', position: 'last' });
  });

  it('shows only the header of a closed shelf, and leaves empty shelves out', () => {
    const cells = gymWallListItems(
      [
        { key: 'same_setup', title: 'Same setup', items: [] },
        { key: 'other', title: 'Other boards here (2)', items: walls('o', 2), toggle: { open: false } },
      ],
      new Set(),
      5,
    );
    expect(shape(cells)).toEqual(['header:header:other']);
    expect(cells[0]).toMatchObject({ toggle: { open: false } });
  });

  it('numbers each shelf from zero', () => {
    const cells = gymWallListItems(
      [
        { key: 'at_gym', title: 'At Crux', items: walls('a', 1) },
        { key: 'listed_nearby', title: 'Listed nearby', items: walls('n', 2) },
      ],
      new Set(),
      5,
    );
    expect(shape(cells)).toEqual([
      'header:header:at_gym',
      'wall:a0:only:0',
      'header:header:listed_nearby',
      'wall:n0:first:0',
      'wall:n1:last:1',
    ]);
  });
});
