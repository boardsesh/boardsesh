import { describe, expect, it } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { selectSmokeClimb, type SmokeSearchSnapshot } from '../select-smoke-climb';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } as UserBoard;
const climb = { uuid: 'first', name: 'First', frames: 'p1083r15', boardType: 'kilter', layoutId: 1 } as Climb;
function snapshot(input: Record<string, unknown> = {}, updatedAt = 1): SmokeSearchSnapshot {
  return {
    input: {
      boardName: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      ...input,
    },
    pages: [{ searchClimbs: { climbs: [climb], hasMore: false } }],
    updatedAt,
  };
}

describe('integration smoke opens a real cached climb', () => {
  it('opens the first result for the current board', () => {
    expect(selectSmokeClimb([snapshot()], board)).toBe(climb);
  });
  it.each([{ boardName: 'tension' }, { layoutId: 2 }, { sizeId: 11 }, { setIds: '2' }, { angle: 45 }])(
    'rejects a stale search after a board/config change: %j',
    (changed) => {
      expect(selectSmokeClimb([snapshot(changed)], board)).toBeNull();
    },
  );
  it('waits for a non-empty, fully hydrated result', () => {
    const empty = snapshot();
    empty.pages = [{ searchClimbs: { climbs: [], hasMore: false } }];
    expect(selectSmokeClimb([empty], board)).toBeNull();
    const unpaintable = snapshot();
    unpaintable.pages = [{ searchClimbs: { climbs: [{ ...climb, frames: '' }], hasMore: false } }];
    expect(selectSmokeClimb([unpaintable], board)).toBeNull();
  });
  it('uses the latest active search when filters changed', () => {
    const older = snapshot({}, 1);
    const newer = snapshot({}, 2);
    newer.pages = [{ searchClimbs: { climbs: [{ ...climb, uuid: 'new-first' }], hasMore: false } }];
    expect(selectSmokeClimb([older, newer], board)?.uuid).toBe('new-first');
  });
});
