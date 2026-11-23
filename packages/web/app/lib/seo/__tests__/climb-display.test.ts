import { describe, expect, it } from 'vite-plus/test';
import { LAYOUTS, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/catalog-metadata';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, type MoonBoardLayoutKey } from '@boardsesh/board-config/moonboard-metadata';
import { WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES } from '@boardsesh/board-config/woods-metadata';
import { getBoardImageDetailsForBoard, type BoardImageDetails } from '@/app/lib/board-image-details';
import type { BoardName } from '@/app/lib/types';
import { boardConfigForSearch, climbBoardForSearch, climbGradeForSearch } from '../climb-display';

describe('readable climb search copy', () => {
  it('puts complete V grades first without losing the Font grade', () => {
    expect(climbGradeForSearch('6a/V3')).toBe('V3 (6a)');
    expect(climbGradeForSearch('V10/7c+')).toBe('V10 (7c+)');
    expect(climbGradeForSearch('V12')).toBe('V12');
    expect(climbGradeForSearch('7a')).toBe('7a');
  });
  it('uses a human board name once', () => {
    expect(climbBoardForSearch('kilter', 'Kilter Board Original')).toBe('Kilter Board Original');
    expect(climbBoardForSearch('tension', 'Original')).toBe('Tension Original');
    expect(climbBoardForSearch('moonboard')).toBe('MoonBoard');
  });
});

/** The catalogue's own board details for one layout and size, every set on it. */
function catalogueBoard(boardName: BoardName, layoutId: number, sizeId: number): BoardImageDetails {
  const setIds = getSetsForLayoutAndSize(boardName, layoutId, sizeId).map((set) => set.id);
  return getBoardImageDetailsForBoard({ board_name: boardName, layout_id: layoutId, size_id: sizeId, set_ids: setIds });
}

/** Every layout and size a board list can be built for: the Aurora catalogue, MoonBoard's layouts and Woods' sizes. */
function everyListableBoard(): BoardImageDetails[] {
  const auroraBoards = (Object.keys(LAYOUTS) as BoardName[]).flatMap((boardName) =>
    Object.keys(LAYOUTS[boardName] ?? {}).flatMap((layoutKey) =>
      getSizesForLayoutId(boardName, Number(layoutKey))
        .filter((size) => getSetsForLayoutAndSize(boardName, Number(layoutKey), size.id).length > 0)
        .map((size) => catalogueBoard(boardName, Number(layoutKey), size.id)),
    ),
  );
  const moonBoards = (Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[]).map((layoutKey) =>
    getBoardImageDetailsForBoard({
      board_name: 'moonboard',
      layout_id: MOONBOARD_LAYOUTS[layoutKey].id,
      size_id: 1,
      set_ids: MOONBOARD_SETS[layoutKey].map((set) => set.id),
    }),
  );
  const woodsBoards = Object.values(WOODS_SIZES).map((size) =>
    getBoardImageDetailsForBoard({
      board_name: 'woods',
      layout_id: WOODS_LAYOUTS.woods.id,
      size_id: size.id,
      set_ids: WOODS_SETS.map((set) => set.id),
    }),
  );
  return [...auroraBoards, ...moonBoards, ...woodsBoards];
}

describe('board configuration search name', () => {
  it('names the layout and the size', () => {
    expect(boardConfigForSearch(catalogueBoard('kilter', 1, 14))).toBe('Kilter Board Original 7x10');
    expect(boardConfigForSearch(catalogueBoard('kilter', 1, 7))).toBe('Kilter Board Original 12x14');
  });

  it("tells Kilter Original's two 12x12s apart by the kickboard", () => {
    expect(boardConfigForSearch(catalogueBoard('kilter', 1, 10))).toBe('Kilter Board Original 12x12 with kickboard');
    expect(boardConfigForSearch(catalogueBoard('kilter', 1, 27))).toBe('Kilter Board Original 12x12 without kickboard');
  });

  it('tells Homewall sizes of one shape apart by their LED kit', () => {
    expect(boardConfigForSearch(catalogueBoard('kilter', 8, 17))).toBe('Kilter Board Homewall 7x10 Full Ride');
    expect(boardConfigForSearch(catalogueBoard('kilter', 8, 18))).toBe('Kilter Board Homewall 7x10 Mainline');
    expect(boardConfigForSearch(catalogueBoard('kilter', 8, 19))).toBe('Kilter Board Homewall 7x10 Auxiliary');
  });

  it('tells Grasshopper sizes with and without Tweeners apart', () => {
    expect(boardConfigForSearch(catalogueBoard('grasshopper', 1, 2))).toBe('Grasshopper 2020 Master 8x12');
    expect(boardConfigForSearch(catalogueBoard('grasshopper', 1, 5))).toBe(
      'Grasshopper 2020 Master 8x12 with Tweeners',
    );
  });

  it("reads Tension's height-first sizes width first, the way Tension names them", () => {
    expect(boardConfigForSearch(catalogueBoard('tension', 10, 7))).toBe('Tension Board 2 Mirror 12x10');
    expect(boardConfigForSearch(catalogueBoard('tension', 10, 10))).toBe('Tension Board 2 Mirror 16x12');
  });

  it('drops "Layout" from Tension\'s first board and keeps a size name with no dimensions', () => {
    expect(boardConfigForSearch(catalogueBoard('tension', 9, 1))).toBe('Tension Original Full Wall');
  });

  it('leaves out the placeholder size every MoonBoard layout shares', () => {
    const [moonBoard2016] = everyListableBoard().filter(
      (board) => board.board_name === 'moonboard' && board.layout_name === 'MoonBoard 2016',
    );
    expect(boardConfigForSearch(moonBoard2016)).toBe('MoonBoard 2016');
  });

  it('falls back to the board brand when the catalogue has no names', () => {
    expect(boardConfigForSearch({ board_name: 'kilter', layout_id: 999, size_id: 999 })).toBe('Kilter');
  });

  it('gives every layout and size in the catalogue its own name, so no two board lists share a title', () => {
    const boards = everyListableBoard();
    const configsByName = new Map<string, string[]>();
    for (const board of boards) {
      const name = boardConfigForSearch(board);
      configsByName.set(name, [
        ...(configsByName.get(name) ?? []),
        `${board.board_name}/${board.layout_id}/${board.size_id}`,
      ]);
    }
    const sharedNames = [...configsByName].filter(([, configs]) => configs.length > 1);

    // Not vacuous: the walk has to reach every catalogue board. Spray walls are
    // not on the list: their layouts are created at runtime and have no board list.
    expect(boards.length).toBeGreaterThan(40);
    expect(new Set(boards.map((board) => board.board_name))).toEqual(
      new Set(['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard', 'woods']),
    );
    expect(sharedNames).toEqual([]);
  });
});
