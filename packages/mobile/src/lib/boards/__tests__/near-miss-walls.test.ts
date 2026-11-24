import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { MOONBOARD_LAYOUTS, MOONBOARD_SIZE, type WallSetup } from '@boardsesh/board-config';
import {
  arrangeExistingWalls,
  describeWallDifference,
  wallDifferenceLine,
  type WallDifferenceCopy,
} from '../near-miss-walls';

const MOONBOARD_2016 = MOONBOARD_LAYOUTS['moonboard-2016'].id;
const MASTERS_2019 = MOONBOARD_LAYOUTS['moonboard-masters-2019'].id;

/** A full Masters 2019: Hold Sets A and B, Original School Holds, Screw-on Feet (20), Wooden Holds A-C. */
const masters2019: WallSetup = {
  boardType: 'moonboard',
  layoutId: MASTERS_2019,
  sizeId: MOONBOARD_SIZE.id,
  setIds: '17,18,19,20,21,22,23',
};

function wall(uuid: string, setup: Partial<WallSetup>): UserBoard {
  return { uuid, name: `Wall ${uuid}`, ...masters2019, ...setup } as unknown as UserBoard;
}

const copy: WallDifferenceCopy = {
  layout: (wallLayout, yours) => `${wallLayout} layout. Yours: ${yours}`,
  size: (wallSize, yours) => `${wallSize} size. Yours: ${yours}`,
  missing: (sets) => `Missing ${sets}`,
  extra: (sets) => `Also has ${sets}`,
};

describe('describeWallDifference', () => {
  it('names the layout for a 2016 record of a Masters 2019 wall', () => {
    const difference = describeWallDifference(masters2019, {
      ...masters2019,
      layoutId: MOONBOARD_2016,
      setIds: '2,3,4',
    });
    expect(difference).toEqual({ kind: 'layout', wall: '2016', yours: 'Masters 2019' });
    expect(wallDifferenceLine(difference!, copy)).toBe('2016 layout. Yours: Masters 2019');
  });

  it('names the feet a Masters 2019 record was entered without', () => {
    const difference = describeWallDifference(masters2019, { ...masters2019, setIds: '17,18,19,21,22,23' });
    expect(difference).toEqual({ kind: 'sets', missing: ['Screw-on Feet'], extra: [] });
    expect(wallDifferenceLine(difference!, copy)).toBe('Missing Screw-on Feet');
  });

  it('names sets the wall has that the climber left out, and both at once', () => {
    const mine = { ...masters2019, setIds: '17,18' };
    expect(describeWallDifference(mine, { ...masters2019, setIds: '17,18,20' })).toEqual({
      kind: 'sets',
      missing: [],
      extra: ['Screw-on Feet'],
    });
    const both = describeWallDifference(mine, { ...masters2019, setIds: '17,20' })!;
    expect(wallDifferenceLine(both, copy)).toBe('Missing Hold Set B. Also has Screw-on Feet');
  });

  it('says nothing for the same setup, another board type, or a layout the catalogue lacks', () => {
    expect(describeWallDifference(masters2019, { ...masters2019, setIds: '23,22,21,20,19,18,17' })).toBeNull();
    expect(describeWallDifference(masters2019, { ...masters2019, boardType: 'kilter' })).toBeNull();
    expect(describeWallDifference(masters2019, { ...masters2019, layoutId: 999 })).toBeNull();
  });
});

describe('arrangeExistingWalls', () => {
  it('draws same setup first, then set up differently, then a possible mismatch', () => {
    const shelves = arrangeExistingWalls(
      masters2019,
      [
        { board: wall('no-feet', { setIds: '17,18,19,21,22,23' }), matchKind: 'SETS_DIFFER' },
        { board: wall('exact', {}), matchKind: 'EXACT' },
      ],
      [wall('seeded-2016', { layoutId: MOONBOARD_2016, setIds: '2,3,4' })],
    );
    expect(shelves.map((shelf) => shelf.key)).toEqual(['same_setup', 'set_up_differently', 'setup_mismatch']);
    expect(shelves.map((shelf) => shelf.walls.map((entry) => entry.board.uuid))).toEqual([
      ['exact'],
      ['no-feet'],
      ['seeded-2016'],
    ]);
    expect(shelves[0].walls[0].difference).toBeNull();
    expect(shelves[1].walls[0].difference).toEqual({ kind: 'sets', missing: ['Screw-on Feet'], extra: [] });
    expect(shelves[2].walls[0].difference).toEqual({ kind: 'layout', wall: '2016', yours: 'Masters 2019' });
  });

  it('never draws a named wall twice, and leaves out empty shelves', () => {
    const exact = wall('exact', {});
    const shelves = arrangeExistingWalls(masters2019, [{ board: exact, matchKind: 'EXACT' }], [exact]);
    expect(shelves).toEqual([{ key: 'same_setup', walls: [{ board: exact, shelf: 'same_setup', difference: null }] }]);
  });

  it("falls back to the server's match when the board type can't be compared, and never drops a named wall", () => {
    const odd = wall('odd', { boardType: 'kilter' });
    expect(arrangeExistingWalls(masters2019, [{ board: odd, matchKind: 'EXACT' }], [])[0].key).toBe('same_setup');
    // Neither side can place it: ask about it rather than acknowledge it unseen.
    expect(arrangeExistingWalls(masters2019, [{ board: odd, matchKind: null }], [])[0].key).toBe('set_up_differently');
    // A query wall of another type is not a mismatch, it's another board.
    expect(arrangeExistingWalls(masters2019, [], [odd])).toEqual([]);
  });
});
