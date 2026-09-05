import { describe, expect, it } from 'vitest';
import { getWoodsBoardDetails } from '@boardsesh/board-config';
import { WOODS_OCCUPIED_HOLD_IDS } from '@boardsesh/board-constants/woods';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { pointInRing } from '@boardsesh/board-art-geometry/ring';

// Read-only production fixtures, verified 2026-09-05. IDs and frames must not
// change when fixing drawing coordinates: the physical LEDs already work.
const REPORTED_CLIMBS = [
  {
    name: 'Iceman',
    uuid: '10316db0-974b-550b-88ba-35c2362f4b64',
    frames: 'p11r3p30r2p172r2p337r2p436r1p464r2p567r1p569r2p670r2p805r4p807r4p822r1p825r1p892r1',
    starts: [805, 807],
  },
  {
    name: 'Sponsorship Stunt Double',
    uuid: 'b2d9486b-2e85-5bac-9ecc-070a36724b3c',
    frames: 'p12r3p47r2p179r2p341r2p342r2p401r2p446r1p537r2p578r1p666r2p677r1p803r4p807r4p819r1p855r1',
    starts: [803, 807],
  },
  {
    name: 'Filter Feeder Feeder',
    uuid: '30dfeb63-8e85-56a2-a52a-ccd887fccba9',
    frames: 'p11r3p44r2p208r2p334r2p435r2p571r1p722r4p730r4p737r1p822r1p884r1',
    starts: [722, 730],
  },
];

describe('Woods report regressions (#4971)', () => {
  const board = getWoodsBoardDetails({ size_id: 2 });
  const geometry = loadBoardArtGeometry({ boardName: 'woods', layoutId: 1, sizeId: 2 })!;
  const holds = new Map(board.holdsData.map((hold) => [hold.id, hold]));

  it.each(REPORTED_CLIMBS)('$name lights physical holds inside the correct 12x12 drawing', (climb) => {
    const starts: number[] = [];
    for (const match of climb.frames.matchAll(/p(\d+)r(\d+)/g)) {
      const id = Number(match[1]);
      const hold = holds.get(id)!;
      expect(WOODS_OCCUPIED_HOLD_IDS['12x12'], `${climb.name} / ${id}`).toContain(id);
      expect(geometry.outlines[id], `${climb.name} / ${id}`).toBeDefined();
      expect(hold.cx - hold.r).toBeGreaterThan(0);
      expect(hold.cx + hold.r).toBeLessThan(board.boardWidth);
      expect(hold.cy - hold.r).toBeGreaterThan(0);
      expect(hold.cy + hold.r).toBeLessThan(board.boardHeight);
      expect(pointInRing(geometry.outlines[id], 0, 0), `${climb.name} / ${id}`).toBe(true);
      if (match[2] === '4') starts.push(id);
    }
    expect(starts).toEqual(climb.starts);
  });

  it.each([
    // Interior landmarks on the real photographed bodies, away from the bolt.
    // They reject the old narrow fragments without pinning exact trace bytes.
    [807, 1106, 1026],
    [722, 444, 944],
    [730, 715, 950],
    [809, 1140, 1020],
  ])('placement %i keeps its hold body', (id, boardX, boardY) => {
    const hold = holds.get(id)!;
    expect(pointInRing(geometry.outlines[id], (boardX - hold.cx) / hold.r, (boardY - hold.cy) / hold.r)).toBe(true);
  });

  it('807 follows the grey hold and excludes the adjacent sloping rail', () => {
    const hold = holds.get(807)!;
    expect(pointInRing(geometry.outlines[807], (1160 - hold.cx) / hold.r, (1015 - hold.cy) / hold.r)).toBe(false);
    expect(geometry.outlines[808]).toBeUndefined();
  });

  it.each([1, 2])('traces every physical hold, and no empty slots, on size %i', (sizeId) => {
    const outlines = loadBoardArtGeometry({ boardName: 'woods', layoutId: 1, sizeId })!.outlines;
    expect(Object.keys(outlines).map(Number)).toEqual(WOODS_OCCUPIED_HOLD_IDS[sizeId === 1 ? '8x10' : '12x12']);
  });

  it('keeps three separate silhouettes where the top-row holds touch beyond the trace crop', () => {
    for (const id of [7, 8, 9]) {
      expect(geometry.outlines[id]).toBeDefined();
      const own = holds.get(id)!;
      for (const otherId of [7, 8, 9].filter((otherId) => otherId !== id)) {
        const other = holds.get(otherId)!;
        expect(pointInRing(geometry.outlines[id], (other.cx - own.cx) / own.r, (other.cy - own.cy) / own.r)).toBe(
          false,
        );
      }
    }
  });
});
