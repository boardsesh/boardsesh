// A gym's wall list (#8151) as the cells of one virtualized list: a header per
// shelf, then each wall as its own slice of an inset-grouped card, then "Show
// all N" as the card's last row while the shelf is collapsed. Pure, so what is
// drawn for a given set of shelves is a table in the tests.

import type { DiscoveryBoardItem } from '../../components/board-discovery/BoardDiscoveryCardView';
import { collapsedRows } from '../../components/board-discovery/picker-top-view';
import { groupedCellPosition, type GroupedCellPosition } from '../../components/gym-page/gym-page-view-model';

export type WallListShelf = {
  key: string;
  title: string;
  items: readonly DiscoveryBoardItem[];
  /**
   * The shelf's rows are tucked behind its header's Show / Hide ("Other boards
   * here"). Absent for the shelves that are always open.
   */
  toggle?: { open: boolean };
};

export type GymWallListItem =
  | { kind: 'header'; key: string; shelfKey: string; title: string; toggle: { open: boolean } | null }
  | {
      kind: 'wall';
      key: string;
      item: DiscoveryBoardItem;
      position: GroupedCellPosition;
      /** 0-based place in its shelf as drawn: what `Board Wall Candidate Used` reports. */
      index: number;
    }
  | { kind: 'showAll'; key: string; shelfKey: string; count: number; position: GroupedCellPosition };

/**
 * Every cell, top to bottom. A shelf shows `collapsedCount` rows (plus the one
 * left over, as `collapsedRows` rounds) until its key is in `expanded`; a shelf
 * with a closed toggle shows only its header. Empty shelves are left out.
 */
export function gymWallListItems(
  shelves: readonly WallListShelf[],
  expanded: ReadonlySet<string>,
  collapsedCount: number,
): GymWallListItem[] {
  const cells: GymWallListItem[] = [];
  for (const shelf of shelves) {
    if (shelf.items.length === 0) continue;
    cells.push({
      kind: 'header',
      key: `header:${shelf.key}`,
      shelfKey: shelf.key,
      title: shelf.title,
      toggle: shelf.toggle ?? null,
    });
    if (shelf.toggle && !shelf.toggle.open) continue;
    const shown = expanded.has(shelf.key) ? shelf.items : collapsedRows(shelf.items, () => false, collapsedCount);
    const hasShowAll = shown.length < shelf.items.length;
    const cardRows = shown.length + (hasShowAll ? 1 : 0);
    shown.forEach((item, index) => {
      cells.push({
        kind: 'wall',
        key: `wall:${shelf.key}:${item.key}`,
        item,
        position: groupedCellPosition(index, cardRows),
        index,
      });
    });
    if (hasShowAll) {
      cells.push({
        kind: 'showAll',
        key: `showAll:${shelf.key}`,
        shelfKey: shelf.key,
        count: shelf.items.length,
        position: groupedCellPosition(shown.length, cardRows),
      });
    }
  }
  return cells;
}
