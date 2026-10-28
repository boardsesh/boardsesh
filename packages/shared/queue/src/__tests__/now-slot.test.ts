import { describe, it, expect } from 'vitest';
import {
  HISTORY_KEEP_COUNT,
  HISTORY_TRIM_AT,
  QUEUE_FULL,
  capHistory,
  chooseQueueEvent,
  clampInsertPosition,
  clampNowSlotPayload,
  historyAndUpNextCount,
  historyLine,
  historyOf,
  isSameWallClimb,
  isUpNextFull,
  lineAfterDelta,
  normaliseHistoryCount,
  normaliseOrphanCurrent,
  placeOnWall,
  historyCopyRuleFor,
  reorderAcrossLine,
  upNextOf,
  upNextStart,
} from '../now-slot';
import type { NowSlotState } from '../now-slot';
import { MAX_SYNCED_QUEUE_ITEMS } from '../limits';
import * as queuePackage from '../index';
import type { ClimbQueueItem } from '../types';

type ItemOverrides = {
  climbUuid?: string;
  angle?: number;
  boardType?: string;
  mirrored?: boolean;
  tickedBy?: string[];
  addedByUser?: ClimbQueueItem['addedByUser'];
};

function makeItem(uuid: string, overrides: ItemOverrides = {}): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: overrides.climbUuid ?? `climb-${uuid}`,
      angle: overrides.angle ?? 40,
      boardType: overrides.boardType,
      mirrored: overrides.mirrored ?? false,
      setter_username: 'setter',
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      ascensionist_count: 0,
      difficulty: '6a',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      benchmark_difficulty: null,
    },
    tickedBy: overrides.tickedBy,
    addedByUser: overrides.addedByUser,
  };
}

/** A fresh queue item for `source`'s climb, as an open mints it. */
function freshCopyOf(source: ClimbQueueItem, uuid: string): ClimbQueueItem {
  return { ...makeItem(uuid), climb: { ...source.climb } };
}

function state(
  queue: readonly ClimbQueueItem[],
  current: ClimbQueueItem | null,
  historyCount?: number | null,
): NowSlotState<ClimbQueueItem> {
  return { queue, currentClimbQueueItem: current, historyCount };
}

const uuids = (queue: readonly { uuid: string }[]) => queue.map(({ uuid }) => uuid);

/** `count` History entries H0..H(count-1). */
function historyItems(count: number): ClimbQueueItem[] {
  return Array.from({ length: count }, (_, index) => makeItem(`H${index}`));
}

describe('upNextStart and the slices', () => {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((uuid) => makeItem(uuid));

  it('starts Up next after the current climb', () => {
    expect(upNextStart([a, b, c, d], b, null)).toBe(2);
    expect(historyLine(state([a, b, c, d], b))).toBe(1);
    expect(uuids(historyOf(state([a, b, c, d], b)))).toEqual(['A']);
    expect(uuids(upNextOf(state([a, b, c, d], b)))).toEqual(['C', 'D']);
  });

  it('ignores historyCount while a climb is current', () => {
    expect(upNextStart([a, b, c, d], b, 3)).toBe(2);
  });

  it('uses historyCount with nothing current', () => {
    expect(upNextStart([a, b, c, d], null, 2)).toBe(2);
    expect(uuids(historyOf(state([a, b, c, d], null, 2)))).toEqual(['A', 'B']);
    expect(uuids(upNextOf(state([a, b, c, d], null, 2)))).toEqual(['C', 'D']);
  });

  it('treats a missing historyCount as 0, today’s display', () => {
    expect(upNextStart([a, b, c, d], null, null)).toBe(0);
    expect(upNextStart([a, b, c, d], null)).toBe(0);
  });

  it('clamps historyCount into the array', () => {
    expect(upNextStart([a, b], null, 7)).toBe(2);
    expect(upNextStart([a, b], null, -3)).toBe(0);
  });

  it('returns historyCount ?? 0 for an orphan current climb', () => {
    const orphan = makeItem('X');
    expect(upNextStart([a, b, c], orphan, 1)).toBe(1);
    expect(upNextStart([a, b, c], orphan, null)).toBe(0);
    expect(historyLine(state([a, b, c], orphan, 1))).toBe(1);
    expect(uuids(upNextOf(state([a, b, c], orphan)))).toEqual(['A', 'B', 'C']);
  });
});

describe('isSameWallClimb (the match key)', () => {
  it('matches on climb uuid and angle', () => {
    expect(isSameWallClimb({ uuid: 'c1', angle: 40 }, { uuid: 'c1', angle: 40 })).toBe(true);
    expect(isSameWallClimb({ uuid: 'c1', angle: 40 }, { uuid: 'c1', angle: 45 })).toBe(false);
    expect(isSameWallClimb({ uuid: 'c1', angle: 40 }, { uuid: 'c2', angle: 40 })).toBe(false);
  });

  it('compares board type only when both sides carry it', () => {
    expect(isSameWallClimb({ uuid: 'c1', angle: 40, boardType: 'kilter' }, { uuid: 'c1', angle: 40 })).toBe(true);
    expect(isSameWallClimb({ uuid: 'c1', angle: 40 }, { uuid: 'c1', angle: 40, boardType: null })).toBe(true);
    expect(
      isSameWallClimb({ uuid: 'c1', angle: 40, boardType: 'kilter' }, { uuid: 'c1', angle: 40, boardType: 'kilter' }),
    ).toBe(true);
    expect(
      isSameWallClimb({ uuid: 'c1', angle: 40, boardType: 'kilter' }, { uuid: 'c1', angle: 40, boardType: 'tension' }),
    ).toBe(false);
  });

  it('ignores the mirror flag', () => {
    const queued = makeItem('C', { mirrored: true });
    const opened = { ...freshCopyOf(queued, 'C2'), climb: { ...queued.climb, mirrored: false } };
    expect(isSameWallClimb(queued.climb, opened.climb)).toBe(true);
  });
});

describe('placeOnWall', () => {
  // Start of every row: A, B (current), C, D. History [A], Up next [C, D].
  const a = makeItem('A');
  const b = makeItem('B');
  const c = makeItem('C');
  const d = makeItem('D');
  const e = makeItem('E');
  const start = state([a, b, c, d], b);

  it('current climb, any placement: nothing moves', () => {
    for (const placement of [undefined, 'NOW', 'STEP'] as const) {
      const placed = placeOnWall(start, b, placement);
      expect(placed.rewrite).toBe('none');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D']);
      expect(placed.currentClimbQueueItem).toBe(b);
      expect(placed.historyCount).toBe(1);
    }
  });

  it('Up next[0], any placement: the pointer moves one step forward', () => {
    for (const placement of [undefined, 'NOW', 'STEP'] as const) {
      const placed = placeOnWall(start, c, placement);
      expect(placed.rewrite).toBe('next');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D']);
      expect(placed.currentClimbQueueItem?.uuid).toBe('C');
      expect(placed.historyCount).toBe(2);
    }
  });

  it('last History entry, STEP or absent: the pointer steps back and the climb you left is Up next[0]', () => {
    for (const placement of [undefined, 'STEP'] as const) {
      const placed = placeOnWall(start, a, placement);
      expect(placed.rewrite).toBe('step');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D']);
      expect(placed.currentClimbQueueItem?.uuid).toBe('A');
      expect(uuids(upNextOf(placed))).toEqual(['B', 'C', 'D']);
    }
  });

  it('History entry that is not the last, a climb current, STEP or absent: the pointer moves back, as today', () => {
    // STEP lands here when a crewmate's open reached the server first.
    for (const placement of [undefined, 'STEP'] as const) {
      const placed = placeOnWall(state([a, b, c, d, e], c), a, placement);
      expect(placed.rewrite).toBe('step');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(placed.currentClimbQueueItem?.uuid).toBe('A');
      expect(uuids(upNextOf(placed))).toEqual(['B', 'C', 'D', 'E']);
    }
  });

  it('History entry, NOW: it moves into the Now slot and the old current goes to History’s end', () => {
    const placed = placeOnWall(state([a, b, c, d, e], c), a, 'NOW');
    expect(placed.rewrite).toBe('move-history');
    expect(uuids(placed.queue)).toEqual(['B', 'C', 'A', 'D', 'E']);
    expect(placed.currentClimbQueueItem?.uuid).toBe('A');
    expect(uuids(historyOf(placed))).toEqual(['B', 'C']);
    expect(uuids(upNextOf(placed))).toEqual(['D', 'E']);
    expect(placed.historyCount).toBe(2);
  });

  it('last History entry, NOW: it swaps with the current climb', () => {
    const placed = placeOnWall(start, a, 'NOW');
    expect(placed.rewrite).toBe('move-history');
    expect(uuids(placed.queue)).toEqual(['B', 'A', 'C', 'D']);
    expect(placed.currentClimbQueueItem?.uuid).toBe('A');
    expect(uuids(upNextOf(placed))).toEqual(['C', 'D']);
  });

  it('Up next at k > 0, any placement: that entry moves into Now and the climbs before it stay in Up next', () => {
    for (const placement of [undefined, 'NOW', 'STEP'] as const) {
      const placed = placeOnWall(start, d, placement);
      expect(placed.rewrite).toBe('move-up-next');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'D', 'C']);
      expect(placed.currentClimbQueueItem?.uuid).toBe('D');
      expect(uuids(historyOf(placed))).toEqual(['A', 'B']);
      expect(uuids(upNextOf(placed))).toEqual(['C']);
    }
  });

  it('new uuid, same climb as current: re-asserts the current climb and drops the new uuid', () => {
    const placed = placeOnWall(start, freshCopyOf(b, 'B2'));
    expect(placed.rewrite).toBe('dedupe-current');
    expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D']);
    expect(placed.currentClimbQueueItem).toBe(b);
  });

  it('new uuid, climb in Up next: the first Up next copy moves into Now', () => {
    const secondD = makeItem('D2', { climbUuid: d.climb.uuid });
    const placed = placeOnWall(state([a, b, c, d, secondD], b), freshCopyOf(d, 'D3'), 'NOW');
    expect(placed.rewrite).toBe('dedupe-up-next');
    expect(uuids(placed.queue)).toEqual(['A', 'B', 'D', 'C', 'D2']);
    expect(placed.currentClimbQueueItem).toBe(d);
  });

  it('new uuid, climb only in History: the newest History copy moves into Now', () => {
    const olderA = makeItem('A0', { climbUuid: a.climb.uuid });
    const placed = placeOnWall(state([olderA, a, b, c], b), freshCopyOf(a, 'A2'));
    expect(placed.rewrite).toBe('dedupe-history');
    expect(uuids(placed.queue)).toEqual(['A0', 'B', 'A', 'C']);
    expect(placed.currentClimbQueueItem).toBe(a);
    expect(uuids(upNextOf(placed))).toEqual(['C']);
  });

  it("new uuid, climb only in History, historyCopy 'fresh': inserted at Now, History left alone", () => {
    const olderA = makeItem('A0', { climbUuid: a.climb.uuid });
    const freshA = freshCopyOf(a, 'A2');
    const placed = placeOnWall(state([olderA, a, b, c], b), freshA, 'NOW', undefined, 'fresh');
    expect(placed.rewrite).toBe('insert');
    expect(uuids(placed.queue)).toEqual(['A0', 'A', 'B', 'A2', 'C']);
    expect(placed.currentClimbQueueItem).toBe(freshA);
    // The rule only covers History: an Up next copy and the current climb still dedupe.
    expect(placeOnWall(state([a, b, c], b), freshCopyOf(c, 'C2'), 'NOW', undefined, 'fresh').rewrite).toBe(
      'dedupe-up-next',
    );
    expect(placeOnWall(state([a, b, c], b), freshCopyOf(b, 'B2'), 'NOW', undefined, 'fresh').rewrite).toBe(
      'dedupe-current',
    );
  });

  it('historyCopyRuleFor: fresh for a request with placement, which the phone already resolved', () => {
    expect(historyCopyRuleFor('NOW')).toBe('fresh');
    expect(historyCopyRuleFor('STEP')).toBe('fresh');
    expect(historyCopyRuleFor(undefined)).toBe('reuse');
    expect(historyCopyRuleFor(null)).toBe('reuse');
  });

  it('prefers the Up next copy over a History copy', () => {
    const historyC = makeItem('C0', { climbUuid: c.climb.uuid });
    const placed = placeOnWall(state([historyC, b, c], b), freshCopyOf(c, 'C2'));
    expect(placed.rewrite).toBe('dedupe-up-next');
    expect(placed.currentClimbQueueItem).toBe(c);
  });

  it('new uuid, climb nowhere: inserted at the Now slot, whatever shouldAddToQueue said', () => {
    for (const shouldAddToQueue of [true, false, undefined]) {
      const x = makeItem('X');
      const placed = placeOnWall(start, x, undefined, shouldAddToQueue);
      expect(placed.rewrite).toBe('insert');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'X', 'C', 'D']);
      expect(placed.currentClimbQueueItem).toBe(x);
      expect(placed.historyCount).toBe(2);
    }
  });

  it('item null: the current climb stays as History’s last entry', () => {
    const placed = placeOnWall(start, null);
    expect(placed.rewrite).toBe('clear');
    expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D']);
    expect(placed.currentClimbQueueItem).toBeNull();
    expect(placed.historyCount).toBe(2);
    expect(uuids(historyOf(placed))).toEqual(['A', 'B']);
    expect(uuids(upNextOf(placed))).toEqual(['C', 'D']);
  });

  it('item null with nothing current keeps the line', () => {
    expect(placeOnWall(state([a, b, c], null, 2), null).historyCount).toBe(2);
  });

  it('the issue’s example: A, B (current), C; tap C in the logbook gives A, B in History and C current', () => {
    const placed = placeOnWall(state([a, b, c], b), freshCopyOf(c, 'C-prime'));
    expect(placed.rewrite).toBe('dedupe-up-next');
    expect(uuids(placed.queue)).toEqual(['A', 'B', 'C']);
    expect(placed.currentClimbQueueItem?.uuid).toBe('C');
    expect(uuids(historyOf(placed))).toEqual(['A', 'B']);
    expect(upNextOf(placed)).toEqual([]);
  });

  describe('the match key', () => {
    it('does not reuse a climb queued at another angle', () => {
      const at45 = makeItem('C45', { climbUuid: c.climb.uuid, angle: 45 });
      const placed = placeOnWall(start, at45);
      expect(placed.rewrite).toBe('insert');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C45', 'C', 'D']);
    });

    it('does not reuse a climb queued for another board type', () => {
      const kilterC = makeItem('C', { boardType: 'kilter' });
      const tensionOpen = makeItem('CT', { climbUuid: kilterC.climb.uuid, boardType: 'tension' });
      expect(placeOnWall(state([a, b, kilterC], b), tensionOpen).rewrite).toBe('insert');
      const untypedOpen = makeItem('CU', { climbUuid: kilterC.climb.uuid });
      expect(placeOnWall(state([a, b, kilterC], b), untypedOpen).rewrite).toBe('dedupe-up-next');
    });

    it('reuses a queued climb whatever its mirror state', () => {
      const mirroredC = makeItem('C', { mirrored: true });
      const placed = placeOnWall(state([a, b, mirroredC], b), makeItem('C2', { climbUuid: mirroredC.climb.uuid }));
      expect(placed.rewrite).toBe('dedupe-up-next');
      expect(placed.currentClimbQueueItem?.climb.mirrored).toBe(true);
    });
  });

  it('a moved entry keeps its uuid, tickedBy, addedByUser and mirror flag', () => {
    const queuedD = makeItem('D', {
      mirrored: true,
      tickedBy: ['user-1'],
      addedByUser: { id: 'user-2', username: 'crewmate' },
    });
    const opened = makeItem('D-fresh', { climbUuid: queuedD.climb.uuid, mirrored: false });
    for (const placed of [
      placeOnWall(state([a, b, c, queuedD], b), opened),
      placeOnWall(state([a, b, c, queuedD], b), queuedD, 'NOW'),
      placeOnWall(state([queuedD, b, c], b), opened, 'NOW'),
    ]) {
      const moved = placed.queue.find(({ uuid }) => uuid === 'D');
      expect(placed.currentClimbQueueItem).toBe(queuedD);
      expect(moved).toBe(queuedD);
      expect(moved?.tickedBy).toEqual(['user-1']);
      expect(moved?.addedByUser).toEqual({ id: 'user-2', username: 'crewmate' });
      expect(moved?.climb.mirrored).toBe(true);
      expect(placed.queue.some(({ uuid }) => uuid === 'D-fresh')).toBe(false);
    }
  });

  it('never mutates its input', () => {
    const frozen = Object.freeze([a, b, c, d]);
    placeOnWall(state(frozen, b), d, 'NOW');
    placeOnWall(state(frozen, b), makeItem('X'));
    placeOnWall(state(frozen, makeItem('O'), 1), a);
    expect(uuids(frozen)).toEqual(['A', 'B', 'C', 'D']);
  });

  describe('with nothing current', () => {
    // A, B, C in History, D, E in Up next, nothing on the wall (after S11).
    const idle = state([a, b, c, d, e], null, 3);

    it('Up next[0] becomes current with a pointer move', () => {
      const placed = placeOnWall(idle, d);
      expect(placed.rewrite).toBe('next');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(placed.historyCount).toBe(3);
    });

    it('an old phone’s Next (queue[0], shouldAddToQueue false) lights Up next[0] and History stays (S12)', () => {
      const placed = placeOnWall(idle, a, undefined, false);
      expect(placed.rewrite).toBe('next-from-line');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(placed.currentClimbQueueItem).toBe(d);
      expect(placed.historyCount).toBe(3);
    });

    it('the native socket on queue[0] (no shouldAddToQueue) lights the climb named, never Up next[0]', () => {
      // Swift keeps the cleared climb's index after CurrentClimbChanged(null),
      // so its Previous from History [A B] names A: a backward press.
      const afterClear = state([a, b, c, d], null, 2);
      const previous = placeOnWall(afterClear, a);
      expect(previous.rewrite).toBe('move-history');
      expect(previous.currentClimbQueueItem).toBe(a);
      expect(uuids(previous.queue)).toEqual(['B', 'A', 'C', 'D']);
      expect(uuids(upNextOf(previous))).toEqual(['C', 'D']);

      const moved = placeOnWall(idle, a);
      expect(moved.rewrite).toBe('move-history');
      expect(moved.currentClimbQueueItem).toBe(a);

      const stepped = placeOnWall(state([a, d, e], null, 1), a);
      expect(stepped.rewrite).toBe('step');
      expect(stepped.currentClimbQueueItem).toBe(a);
      expect(uuids(stepped.queue)).toEqual(['A', 'D', 'E']);
    });

    it('next-from-line with 60 History climbs keeps all 60 (S15)', () => {
      const history = historyItems(60);
      const placed = placeOnWall(state([...history, d, e], null, 60), history[0], undefined, false);
      expect(placed.rewrite).toBe('next-from-line');
      expect(placed.currentClimbQueueItem).toBe(d);
      expect(historyOf(placed)).toHaveLength(60);
      expect(uuids(upNextOf(placed))).toEqual(['E']);
    });

    it('next-from-line from a single History entry', () => {
      const placed = placeOnWall(state([a, d, e], null, 1), a, undefined, false);
      expect(placed.rewrite).toBe('next-from-line');
      expect(placed.currentClimbQueueItem).toBe(d);
      expect(uuids(historyOf(placed))).toEqual(['A']);
    });

    it('queue[0] with Up next empty is not a Next: move-history, or step at one History entry', () => {
      const moved = placeOnWall(state([a, b, c], null, 3), a, undefined, false);
      expect(moved.rewrite).toBe('move-history');
      expect(uuids(moved.queue)).toEqual(['B', 'C', 'A']);
      expect(moved.historyCount).toBe(2);

      const stepped = placeOnWall(state([a], null, 1), a, undefined, false);
      expect(stepped.rewrite).toBe('step');
      expect(stepped.historyCount).toBe(0);
    });

    it('a row tap on queue[0] (shouldAddToQueue true) lights the climb tapped (S18)', () => {
      const history = historyItems(60);
      const placed = placeOnWall(state([...history, d, e], null, 60), history[0], undefined, true);
      expect(placed.rewrite).toBe('move-history');
      expect(placed.currentClimbQueueItem).toBe(history[0]);
      expect(uuids(placed.queue)).toEqual([...uuids(history.slice(1)), 'H0', 'D', 'E']);
      expect(placed.historyCount).toBe(59);

      const single = placeOnWall(state([a, d, e], null, 1), a, undefined, true);
      expect(single.rewrite).toBe('step');
      expect(single.currentClimbQueueItem).toBe(a);
      expect(uuids(upNextOf(single))).toEqual(['D', 'E']);
    });

    it('a placement on queue[0] is never read as an old Next', () => {
      expect(placeOnWall(idle, a, 'NOW').rewrite).toBe('move-history');
      expect(placeOnWall(idle, a, 'STEP').rewrite).toBe('move-history');
    });

    it('any other History entry without placement moves into the Now slot, never a spill', () => {
      const placed = placeOnWall(idle, b, undefined, false);
      expect(placed.rewrite).toBe('move-history');
      expect(uuids(placed.queue)).toEqual(['A', 'C', 'B', 'D', 'E']);
      expect(uuids(historyOf(placed))).toEqual(['A', 'C']);
      expect(uuids(upNextOf(placed))).toEqual(['D', 'E']);
    });

    it('History’s last entry without placement is a pointer step', () => {
      const placed = placeOnWall(idle, c);
      expect(placed.rewrite).toBe('step');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(placed.historyCount).toBe(2);
    });

    it('a History entry with NOW moves onto the line', () => {
      const placed = placeOnWall(idle, a, 'NOW');
      expect(placed.rewrite).toBe('move-history');
      expect(uuids(placed.queue)).toEqual(['B', 'C', 'A', 'D', 'E']);
      expect(uuids(historyOf(placed))).toEqual(['B', 'C']);
      expect(uuids(upNextOf(placed))).toEqual(['D', 'E']);
    });

    it('History’s last entry with NOW already sits on the line: a pointer step', () => {
      const placed = placeOnWall(idle, c, 'NOW');
      expect(placed.rewrite).toBe('step');
      expect(placed.currentClimbQueueItem).toBe(c);
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(placed.historyCount).toBe(2);
    });

    it('an Up next entry at k > 0 moves onto the line', () => {
      const placed = placeOnWall(idle, e);
      expect(placed.rewrite).toBe('move-up-next');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'E', 'D']);
    });

    it('a new climb is inserted on the line, not at the end', () => {
      const placed = placeOnWall(idle, makeItem('X'));
      expect(placed.rewrite).toBe('insert');
      expect(uuids(placed.queue)).toEqual(['A', 'B', 'C', 'X', 'D', 'E']);
      expect(uuids(historyOf(placed))).toEqual(['A', 'B', 'C']);
    });

    it('a pre-F3 state (no historyCount) inserts at the head, which is today’s all-Up-next display', () => {
      const placed = placeOnWall(state([a, b], null), makeItem('X'));
      expect(uuids(placed.queue)).toEqual(['X', 'A', 'B']);
      expect(placed.historyCount).toBe(0);
    });
  });

  describe('an orphan current climb in the stored state', () => {
    const orphan = makeItem('O');

    it('is inserted at the line first, then the table applies', () => {
      const relit = placeOnWall(state([a, b, c], orphan, 1), orphan);
      expect(relit.rewrite).toBe('none');
      expect(uuids(relit.queue)).toEqual(['A', 'O', 'B', 'C']);
      expect(relit.historyCount).toBe(1);

      const replaced = placeOnWall(state([a, b, c], orphan, 1), makeItem('X'));
      expect(replaced.rewrite).toBe('insert');
      expect(uuids(replaced.queue)).toEqual(['A', 'O', 'X', 'B', 'C']);
      expect(uuids(historyOf(replaced))).toEqual(['A', 'O']);
    });

    it('a pre-PR-2 room (no historyCount) puts it at the head, its old phones’ Next then lights A', () => {
      const placed = placeOnWall(state([a, b, c], orphan), a, undefined, false);
      expect(placed.rewrite).toBe('next');
      expect(uuids(placed.queue)).toEqual(['O', 'A', 'B', 'C']);
      expect(placed.currentClimbQueueItem).toBe(a);
    });
  });
});

describe('normaliseOrphanCurrent', () => {
  const [a, b, c] = ['A', 'B', 'C'].map((uuid) => makeItem(uuid));
  const orphan = makeItem('X');

  it('inserts a payload orphan at the line: a fresh join [A B C] + X gives [X A B C]', () => {
    const joined = normaliseOrphanCurrent(state([a, b, c], orphan));
    expect(joined.normalised).toBe(true);
    expect(uuids(joined.queue)).toEqual(['X', 'A', 'B', 'C']);
    expect(joined.currentClimbQueueItem).toBe(orphan);
    expect(joined.historyCount).toBe(0);
    expect(uuids(upNextOf(joined))).toEqual(['A', 'B', 'C']);
  });

  it('uses the sent line, through normaliseHistoryCount', () => {
    const line = normaliseHistoryCount(2, [a, b, c], orphan);
    expect(line).toBe(2);
    const placed = normaliseOrphanCurrent(state([a, b, c], orphan, line));
    expect(uuids(placed.queue)).toEqual(['A', 'B', 'X', 'C']);
    expect(uuids(historyOf(placed))).toEqual(['A', 'B']);
  });

  it('stores [current] for a join that seeds only a current climb', () => {
    expect(uuids(normaliseOrphanCurrent(state([], orphan)).queue)).toEqual(['X']);
  });

  it('leaves a queued or missing current climb alone', () => {
    const queued = normaliseOrphanCurrent(state([a, b], b));
    expect(queued.normalised).toBe(false);
    expect(queued.historyCount).toBe(1);
    const idle = normaliseOrphanCurrent(state([a, b], null, 1));
    expect(idle.normalised).toBe(false);
    expect(idle.historyCount).toBe(1);
  });
});

describe('capHistory', () => {
  function longHistory(historyLength: number, upNextLength: number) {
    const history = historyItems(historyLength);
    const current = makeItem('NOW');
    const upNext = Array.from({ length: upNextLength }, (_, index) => makeItem(`U${index}`));
    return { history, current, upNext, queue: [...history, current, ...upNext] };
  }

  it('leaves History under 125 alone', () => {
    const { queue, current } = longHistory(HISTORY_TRIM_AT - 1, 3);
    const capped = capHistory(state(queue, current));
    expect(capped.trimmedCount).toBe(0);
    expect(capped.queue).toHaveLength(queue.length);
    expect(capped.historyCount).toBe(HISTORY_TRIM_AT - 1);
  });

  it('trims History at 125 to the newest 100', () => {
    const { queue, current, history } = longHistory(HISTORY_TRIM_AT, 3);
    const capped = capHistory(state(queue, current));
    expect(capped.trimmedCount).toBe(HISTORY_TRIM_AT - HISTORY_KEEP_COUNT);
    expect(capped.historyCount).toBe(HISTORY_KEEP_COUNT);
    expect(capped.queue[0].uuid).toBe(history[HISTORY_TRIM_AT - HISTORY_KEEP_COUNT].uuid);
    expect(capped.queue[HISTORY_KEEP_COUNT]).toBe(current);
    expect(capped.currentClimbQueueItem).toBe(current);
    expect(uuids(upNextOf(capped))).toEqual(['U0', 'U1', 'U2']);
  });

  it('trims History with nothing current by the line', () => {
    const capped = capHistory(state([...historyItems(HISTORY_TRIM_AT), makeItem('U0')], null, HISTORY_TRIM_AT));
    expect(capped.historyCount).toBe(HISTORY_KEEP_COUNT);
    expect(capped.queue).toHaveLength(HISTORY_KEEP_COUNT + 1);
    expect(capped.queue.at(-1)?.uuid).toBe('U0');
  });

  it('does not count the climb on the wall toward the cap', () => {
    const { queue, current } = longHistory(50, MAX_SYNCED_QUEUE_ITEMS - 50);
    // 50 + 1 + 450 = 501 entries; History + Up next is exactly 500.
    expect(historyAndUpNextCount(state(queue, current))).toBe(MAX_SYNCED_QUEUE_ITEMS);
    const capped = capHistory(state(queue, current));
    expect(capped.trimmedCount).toBe(0);
    expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
  });

  it('drops more History when History + Up next would pass 500', () => {
    const { queue, current } = longHistory(50, MAX_SYNCED_QUEUE_ITEMS - 49);
    // 50 + 1 + 451 = 502 entries, 501 of them History + Up next.
    const capped = capHistory(state(queue, current));
    expect(capped.trimmedCount).toBe(1);
    expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(capped.queue[0].uuid).toBe('H1');
  });

  it('caps the whole array at 500 with nothing current', () => {
    const upNext = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS - 1 }, (_, index) => makeItem(`U${index}`));
    const capped = capHistory(state([...historyItems(2), ...upNext], null, 2));
    expect(capped.trimmedCount).toBe(1);
    expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(capped.historyCount).toBe(1);
  });

  it('makes room for the entries about to be added', () => {
    const { queue, current } = longHistory(10, MAX_SYNCED_QUEUE_ITEMS - 10);
    // 501 entries, History + Up next at 500; one more is about to come.
    const capped = capHistory(state(queue, current), 1);
    expect(capped.trimmedCount).toBe(1);
    expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
  });

  it('never trims the current climb or Up next', () => {
    const { queue, current } = longHistory(2, MAX_SYNCED_QUEUE_ITEMS + 5);
    const capped = capHistory(state(queue, current), 1);
    expect(capped.trimmedCount).toBe(2);
    expect(capped.queue[0]).toBe(current);
    expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 6);
    expect(isUpNextFull(capped, 0)).toBe(true);
  });

  describe('QUEUE_FULL', () => {
    it('is the GraphQL error code', () => {
      expect(QUEUE_FULL).toBe('QUEUE_FULL');
    });

    it('rejects an add only when Up next alone fills the cap', () => {
      const full = longHistory(30, MAX_SYNCED_QUEUE_ITEMS);
      // History goes first, all of it, and Up next is still 500.
      expect(isUpNextFull(state(full.queue, full.current))).toBe(true);
      const fullState = capHistory(state(full.queue, full.current), 1);
      expect(fullState.trimmedCount).toBe(30);
      expect(fullState.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(isUpNextFull(fullState)).toBe(true);

      const roomy = longHistory(30, MAX_SYNCED_QUEUE_ITEMS - 1);
      expect(isUpNextFull(state(roomy.queue, roomy.current))).toBe(false);
      const roomyState = capHistory(state(roomy.queue, roomy.current), 1);
      // After the add: the climb on the wall plus 500 History + Up next.
      expect(roomyState.queue.length + 1).toBe(MAX_SYNCED_QUEUE_ITEMS + 1);
    });

    it('rejects an add with nothing current and 500 in Up next', () => {
      const upNext = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS }, (_, index) => makeItem(`U${index}`));
      expect(isUpNextFull(state(upNext, null, 0))).toBe(true);
      expect(isUpNextFull(state(upNext.slice(1), null, 0))).toBe(false);
    });

    it('lets a setQueue through up to exactly 500 in Up next', () => {
      const exact = longHistory(0, MAX_SYNCED_QUEUE_ITEMS);
      expect(exact.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(isUpNextFull(state(exact.queue, exact.current), 0)).toBe(false);
      const over = longHistory(0, MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(isUpNextFull(state(over.queue, over.current), 0)).toBe(true);
    });
  });

  describe('at the cap: the climb on the wall is extra', () => {
    const fullUpNext = () => Array.from({ length: MAX_SYNCED_QUEUE_ITEMS }, (_, index) => makeItem(`U${index}`));

    it('opens a new climb with nothing current and Up next at 500: 501 entries, nothing refused', () => {
      const upNext = fullUpNext();
      const opened = makeItem('X');
      const placed = placeOnWall(state(upNext, null, 0), opened, 'NOW');
      expect(placed.rewrite).toBe('insert');
      const capped = capHistory(placed);
      expect(capped.trimmedCount).toBe(0);
      expect(capped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(capped.currentClimbQueueItem).toBe(opened);
      expect(uuids(upNextOf(capped))).toEqual(uuids(upNext));
      expect(historyAndUpNextCount(capped)).toBe(MAX_SYNCED_QUEUE_ITEMS);
    });

    it('the same open from an old phone (no placement) is not refused either', () => {
      const placed = placeOnWall(state(fullUpNext(), null, 0), makeItem('X'), undefined, true);
      expect(capHistory(placed).queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    });

    it('Next from there moves the opened climb to History and trims nothing', () => {
      const upNext = fullUpNext();
      const opened = makeItem('X');
      const atCap = capHistory(placeOnWall(state(upNext, null, 0), opened, 'NOW'));
      const next = capHistory(placeOnWall(atCap, upNext[0], 'NOW'));
      expect(next.trimmedCount).toBe(0);
      expect(next.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(uuids(historyOf(next))).toEqual(['X']);
      expect(next.currentClimbQueueItem?.uuid).toBe('U0');
      expect(upNextOf(next)).toHaveLength(MAX_SYNCED_QUEUE_ITEMS - 1);
    });

    it('a clear with no other History drops the cleared climb instead of storing 501 with nothing current', () => {
      const upNext = fullUpNext();
      const opened = makeItem('X');
      const atCap = capHistory(placeOnWall(state(upNext, null, 0), opened, 'NOW'));
      const cleared = capHistory(placeOnWall(atCap, null));
      expect(cleared.trimmedCount).toBe(1);
      expect(cleared.currentClimbQueueItem).toBeNull();
      expect(cleared.historyCount).toBe(0);
      expect(uuids(cleared.queue)).toEqual(uuids(upNext));
    });

    it('a clear with older History trims that first, and the cleared climb joins History', () => {
      const upNext = fullUpNext().slice(1);
      const current = makeItem('X');
      // [H0 | X | U0..U498]: 501 entries, History + Up next at 500.
      const before = state([makeItem('H0'), current, ...upNext], current);
      const cleared = capHistory(placeOnWall(before, null));
      expect(cleared.trimmedCount).toBe(1);
      expect(uuids(historyOf(cleared))).toEqual(['X']);
      expect(cleared.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
      expect(uuids(upNextOf(cleared))).toEqual(uuids(upNext));
    });

    it('opening a new climb while one is current at the cap drops the oldest History, here the old current', () => {
      const upNext = fullUpNext();
      const current = makeItem('X');
      const opened = makeItem('Y');
      const placed = capHistory(placeOnWall(state([current, ...upNext], current), opened, 'NOW'));
      expect(placed.trimmedCount).toBe(1);
      expect(placed.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
      expect(placed.currentClimbQueueItem).toBe(opened);
      expect(uuids(upNextOf(placed))).toEqual(uuids(upNext));
    });
  });
});

describe('lineAfterDelta (the line table)', () => {
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((uuid) => makeItem(uuid));
  // Nothing current, History [A B], Up next [C D].
  const idle = state([a, b, c, d], null, 2);

  it('add at p: +1 when p < historyCount, else unchanged', () => {
    expect(lineAfterDelta(idle, { kind: 'add', index: 0 })).toBe(3);
    expect(lineAfterDelta(idle, { kind: 'add', index: 1 })).toBe(3);
    expect(lineAfterDelta(idle, { kind: 'add', index: 2 })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'add', index: 4 })).toBe(2);
  });

  it('add at an out-of-range index appends, as insertQueueItemIdempotent does', () => {
    expect(lineAfterDelta(idle, { kind: 'add', index: -1 })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'add', index: 5 })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'add', index: Number.NaN })).toBe(2);
    const withCurrent = state([a, b, c, d], b);
    expect(lineAfterDelta(withCurrent, { kind: 'add', index: -1 })).toBe(1);
  });

  it('remove at i: −1 when i < historyCount, else unchanged', () => {
    expect(lineAfterDelta(idle, { kind: 'remove', uuid: 'A' })).toBe(1);
    expect(lineAfterDelta(idle, { kind: 'remove', uuid: 'B' })).toBe(1);
    expect(lineAfterDelta(idle, { kind: 'remove', uuid: 'C' })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'remove', uuid: 'missing' })).toBe(2);
  });

  it('reorder i → j: −1 when i < historyCount ≤ j', () => {
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 0, newIndex: 2 })).toBe(1);
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 1, newIndex: 3 })).toBe(1);
  });

  it('reorder i → j: +1 when j < historyCount ≤ i', () => {
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 2, newIndex: 1 })).toBe(3);
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 3, newIndex: 0 })).toBe(3);
  });

  it('reorder at the boundaries j = historyCount and j = historyCount − 1', () => {
    // History entry to j = historyCount: it crosses into Up next.
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 0, newIndex: 2 })).toBe(1);
    // History entry to j = historyCount − 1: it stays History.
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 0, newIndex: 1 })).toBe(2);
    // Up next entry to j = historyCount: it stays Up next.
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 3, newIndex: 2 })).toBe(2);
    // Up next entry to j = historyCount − 1: it crosses into History.
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 3, newIndex: 1 })).toBe(3);
  });

  it('reorder within one side leaves it alone; out of range is ignored', () => {
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 2, newIndex: 3 })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'reorder', oldIndex: 0, newIndex: 9 })).toBe(2);
  });

  it('trim of n: −n', () => {
    expect(lineAfterDelta(idle, { kind: 'trim', count: 2 })).toBe(0);
    expect(lineAfterDelta(idle, { kind: 'trim', count: 1 })).toBe(1);
  });

  it('removing the current climb: its index', () => {
    expect(lineAfterDelta(state([a, b, c, d], c), { kind: 'remove', uuid: 'C' })).toBe(2);
    expect(lineAfterDelta(state([a, b, c, d], a), { kind: 'remove', uuid: 'A' })).toBe(0);
  });

  it('setCurrentClimb(null): the cleared climb’s index + 1', () => {
    expect(lineAfterDelta(state([a, b, c, d], b), { kind: 'clear' })).toBe(2);
    expect(lineAfterDelta(idle, { kind: 'clear' })).toBe(2);
  });

  it('with a climb current, the result is its index after the change', () => {
    const current = state([a, b, c, d, e], c);
    expect(lineAfterDelta(current, { kind: 'add', index: 0 })).toBe(3);
    expect(lineAfterDelta(current, { kind: 'add', index: 2 })).toBe(3);
    expect(lineAfterDelta(current, { kind: 'add', index: 3 })).toBe(2);
    expect(lineAfterDelta(current, { kind: 'remove', uuid: 'A' })).toBe(1);
    expect(lineAfterDelta(current, { kind: 'remove', uuid: 'E' })).toBe(2);
    expect(lineAfterDelta(current, { kind: 'reorder', oldIndex: 2, newIndex: 4 })).toBe(4);
    expect(lineAfterDelta(current, { kind: 'reorder', oldIndex: 0, newIndex: 4 })).toBe(1);
    expect(lineAfterDelta(current, { kind: 'reorder', oldIndex: 4, newIndex: 0 })).toBe(3);
    expect(lineAfterDelta(current, { kind: 'reorder', oldIndex: 4, newIndex: 2 })).toBe(3);
    expect(lineAfterDelta(current, { kind: 'reorder', oldIndex: 4, newIndex: 3 })).toBe(2);
    expect(lineAfterDelta(current, { kind: 'trim', count: 2 })).toBe(0);
  });

  it('agrees with the line of the array it describes, for every add, remove and reorder', () => {
    // A brute-force check over a small queue: the line after the delta keeps
    // the same climbs on each side as before (the moved or added one aside).
    const queue = [a, b, c, d, e];
    for (const historyCount of [0, 1, 2, 3, 4, 5]) {
      const before = state(queue, null, historyCount);
      const historyBefore = new Set(uuids(queue.slice(0, historyCount)));
      for (let oldIndex = 0; oldIndex < queue.length; oldIndex++) {
        for (let newIndex = 0; newIndex < queue.length; newIndex++) {
          const reordered = [...queue];
          const [moved] = reordered.splice(oldIndex, 1);
          reordered.splice(newIndex, 0, moved);
          const line = lineAfterDelta(before, { kind: 'reorder', oldIndex, newIndex });
          const historyAfter = reordered.slice(0, line).filter(({ uuid }) => uuid !== moved.uuid);
          const upNextAfter = reordered.slice(line).filter(({ uuid }) => uuid !== moved.uuid);
          expect(historyAfter.every(({ uuid }) => historyBefore.has(uuid))).toBe(true);
          expect(upNextAfter.every(({ uuid }) => !historyBefore.has(uuid))).toBe(true);
          // The moved entry joins the side its new neighbours are on; on the
          // line itself it keeps its own side.
          const wasHistory = oldIndex < historyCount;
          const lineWithoutMoved = wasHistory ? historyCount - 1 : historyCount;
          const expectHistory = newIndex < lineWithoutMoved || (newIndex === lineWithoutMoved && wasHistory);
          expect(newIndex < line).toBe(expectHistory);
        }
      }
    }
  });
});

describe('reorderAcrossLine', () => {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((uuid) => makeItem(uuid));

  it('lets the line follow the current climb', () => {
    const result = reorderAcrossLine(state([a, b, c, d], b), 3, 0);
    expect(result?.clamped).toBe(false);
    expect(uuids(result?.queue ?? [])).toEqual(['D', 'A', 'B', 'C']);
    expect(result?.historyCount).toBe(2);
  });

  it('nothing current: a History entry dragged below the line joins Up next', () => {
    const result = reorderAcrossLine(state([a, b, c, d], null, 2), 0, 3);
    expect(result?.clamped).toBe(false);
    expect(uuids(result?.queue ?? [])).toEqual(['B', 'C', 'D', 'A']);
    expect(result?.historyCount).toBe(1);
  });

  it('nothing current: an Up next entry dragged above the line is clamped to the head of Up next', () => {
    const result = reorderAcrossLine(state([a, b, c, d], null, 2), 3, 0);
    expect(result?.clamped).toBe(true);
    expect(result?.newIndex).toBe(2);
    expect(uuids(result?.queue ?? [])).toEqual(['A', 'B', 'D', 'C']);
    expect(result?.historyCount).toBe(2);
  });

  it('nothing current: a move within one side leaves historyCount alone', () => {
    expect(reorderAcrossLine(state([a, b, c, d], null, 2), 0, 1)?.historyCount).toBe(2);
    expect(reorderAcrossLine(state([a, b, c, d], null, 2), 2, 3)?.historyCount).toBe(2);
  });

  it('rejects an out-of-range reorder', () => {
    expect(reorderAcrossLine(state([a, b], null, 1), 0, 2)).toBeNull();
    expect(reorderAcrossLine(state([a, b], null, 1), -1, 0)).toBeNull();
  });
});

describe('clampInsertPosition', () => {
  const [a, b, c] = ['A', 'B', 'C'].map((uuid) => makeItem(uuid));

  it('honours a position inside History while a climb is current', () => {
    expect(clampInsertPosition(state([a, b, c], b), 0)).toEqual({ index: 0, clamped: false });
  });

  it('clamps a position inside History to the line with nothing current (S16)', () => {
    expect(clampInsertPosition(state([a, b, c], null, 2), 0)).toEqual({ index: 2, clamped: true });
    expect(clampInsertPosition(state([a, b, c], null, 2), 2)).toEqual({ index: 2, clamped: false });
  });

  it('appends without a position or with one out of range', () => {
    expect(clampInsertPosition(state([a, b, c], null, 2), undefined)).toEqual({ index: 3, clamped: false });
    expect(clampInsertPosition(state([a, b, c], null, 2), 9)).toEqual({ index: 3, clamped: false });
    expect(clampInsertPosition(state([a, b, c], null, 2), -1)).toEqual({ index: 3, clamped: false });
  });
});

describe('normaliseHistoryCount', () => {
  const [a, b, c] = ['A', 'B', 'C'].map((uuid) => makeItem(uuid));

  it('clamps -1 and 9999 into [0, length]', () => {
    expect(normaliseHistoryCount(-1, [a, b, c], null)).toBe(0);
    expect(normaliseHistoryCount(9999, [a, b, c], null)).toBe(3);
    expect(normaliseHistoryCount(2, [a, b, c], null)).toBe(2);
  });

  it('ignores the input when the write carries a current climb in its queue', () => {
    expect(normaliseHistoryCount(0, [a, b, c], c)).toBe(2);
    expect(normaliseHistoryCount(9999, [a, b, c], a)).toBe(0);
    expect(normaliseHistoryCount(null, [a, b, c], b)).toBe(1);
  });

  it('returns null without a usable input, so the caller derives the line', () => {
    expect(normaliseHistoryCount(null, [a, b, c], null)).toBeNull();
    expect(normaliseHistoryCount(undefined, [a, b, c], null)).toBeNull();
    expect(normaliseHistoryCount(Number.NaN, [a, b, c], null)).toBeNull();
  });

  it('uses the input as a payload orphan’s line', () => {
    expect(normaliseHistoryCount(1, [a, b, c], makeItem('X'))).toBe(1);
  });
});

describe('chooseQueueEvent', () => {
  const a = makeItem('A');
  const b = makeItem('B');
  const c = makeItem('C');
  const d = makeItem('D');
  const e = makeItem('E');
  const before = state([a, b, c, d], b);

  function eventFor(
    item: ClimbQueueItem | null,
    request: { shouldAddToQueue?: boolean; placement?: 'NOW' | 'STEP' } = {},
    from: NowSlotState<ClimbQueueItem> = before,
  ) {
    const placed = capHistory(placeOnWall(from, item, request.placement, request.shouldAddToQueue));
    return chooseQueueEvent(from, { item, ...request }, placed);
  }

  it('sends a pointer event when the array does not change (none, next, step)', () => {
    expect(eventFor(b)).toBe('pointer');
    expect(eventFor(c, { placement: 'NOW' })).toBe('pointer');
    expect(eventFor(a, { placement: 'STEP' })).toBe('pointer');
    expect(eventFor(a)).toBe('pointer');
  });

  it('STEP onto a History entry that is no longer last is still a pointer step', () => {
    // A new phone named B as History's last; a crewmate's open of C landed first.
    const raced = state([a, b, c, d, e], c);
    expect(placeOnWall(raced, a, 'STEP').rewrite).toBe('step');
    expect(eventFor(a, { placement: 'STEP' }, raced)).toBe('pointer');
  });

  it('keeps CurrentClimbChanged(null) for a clear that does not reshape the array', () => {
    expect(eventFor(null)).toBe('pointer');
    // Nothing current already, a clear changes nothing.
    expect(eventFor(null, {}, state([a, b, c, d], null, 2))).toBe('pointer');
  });

  it('a clear that trims is a plain FullSync, with no trailing CurrentClimbChanged(null) (section 5)', () => {
    // One current climb and 500 Up next: the cleared climb becomes History's
    // only entry, History + Up next is 501, and the trim removes it.
    const current = makeItem('NOW');
    const upNext = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS }, (_, index) => makeItem(`U${index}`));
    const full = state([current, ...upNext], current, 0);
    const placed = capHistory(placeOnWall(full, null));
    expect(placed.trimmedCount).toBe(1);
    expect(uuids(placed.queue)).toEqual(uuids(upNext));
    expect(placed.currentClimbQueueItem).toBeNull();
    expect(chooseQueueEvent(full, { item: null }, placed)).toBe('fullsync');
  });

  it('a clear that trims old History is a plain FullSync', () => {
    const history = historyItems(10);
    const current = makeItem('NOW');
    const upNext = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS - 10 }, (_, index) => makeItem(`U${index}`));
    const full = state([...history, current, ...upNext], current);
    const placed = capHistory(placeOnWall(full, null));
    expect(placed.trimmedCount).toBe(1);
    expect(placed.queue[0].uuid).toBe('H1');
    expect(eventFor(null, {}, full)).toBe('fullsync');
    expect(eventFor(null, { placement: 'NOW' }, full)).toBe('fullsync');
  });

  it('a clear at 125 History entries trims to 100 with a plain FullSync', () => {
    const history = historyItems(HISTORY_TRIM_AT - 1);
    const current = makeItem('NOW');
    const longState = state([...history, current, makeItem('U0')], current);
    expect(capHistory(placeOnWall(longState, null)).trimmedCount).toBeGreaterThan(0);
    expect(eventFor(null, {}, longState)).toBe('fullsync');
  });

  it('sends a plain FullSync for an insert that asked to add or carried placement', () => {
    expect(eventFor(makeItem('X'), { shouldAddToQueue: true })).toBe('fullsync');
    expect(eventFor(makeItem('X'), { placement: 'NOW' })).toBe('fullsync');
  });

  it('adds the trailing event for an insert from the native socket', () => {
    expect(eventFor(makeItem('X'))).toBe('fullsync+trailing');
    expect(eventFor(makeItem('X'), { shouldAddToQueue: false })).toBe('fullsync+trailing');
  });

  it('adds the trailing event for every move and dedupe, dedupe-current included', () => {
    expect(eventFor(d)).toBe('fullsync+trailing');
    expect(eventFor(a, { placement: 'NOW' })).toBe('fullsync+trailing');
    expect(eventFor(freshCopyOf(b, 'B2'), { shouldAddToQueue: true })).toBe('fullsync+trailing');
    expect(eventFor(freshCopyOf(c, 'C2'), { shouldAddToQueue: true })).toBe('fullsync+trailing');
    expect(eventFor(freshCopyOf(a, 'A2'), { shouldAddToQueue: true })).toBe('fullsync+trailing');
  });

  it('nothing current: next-from-line is a FullSync + trailing, never a pointer the old phone would drop', () => {
    const idle = state([a, b, c, d], null, 2);
    expect(eventFor(a, { shouldAddToQueue: false }, idle)).toBe('fullsync+trailing');
  });

  it('nothing current: a new phone’s Next to queue[historyCount] is a pointer event (S13)', () => {
    const idle = state([a, b, c, d], null, 2);
    expect(eventFor(c, { placement: 'NOW' }, idle)).toBe('pointer');
  });

  it('nothing current: NOW on History’s last entry is a pointer event, rewrite step', () => {
    const idle = state([a, b, c, d], null, 2);
    expect(placeOnWall(idle, b, 'NOW').rewrite).toBe('step');
    expect(eventFor(b, { placement: 'NOW' }, idle)).toBe('pointer');
  });

  it('nothing current: no History reshape is a pointer event', () => {
    const idle = state([a, b, c, d, e], null, 3);
    for (const [item, request] of [
      [b, { shouldAddToQueue: false }],
      [a, { shouldAddToQueue: true }],
      [a, { placement: 'NOW' }],
      [e, {}],
    ] as const) {
      expect(placeOnWall(idle, item, request.placement, request.shouldAddToQueue).queue).not.toEqual(idle.queue);
      expect(eventFor(item, request, idle)).toBe('fullsync+trailing');
    }
  });

  it('a stored orphan makes any write a FullSync, + trailing when it names a climb', () => {
    const orphanRoom = state([a, b, c], makeItem('O'));
    expect(eventFor(a, { shouldAddToQueue: false }, orphanRoom)).toBe('fullsync+trailing');
    expect(eventFor(makeItem('X'), { shouldAddToQueue: true }, orphanRoom)).toBe('fullsync+trailing');
    // A clear normalises the orphan too, but has no climb to repaint.
    expect(eventFor(null, {}, orphanRoom)).toBe('fullsync');
  });

  it('adds the trailing event when a placement trims History, even a pointer move', () => {
    const history = historyItems(HISTORY_TRIM_AT - 1);
    const current = makeItem('NOW');
    const next = makeItem('U0');
    const longState = state([...history, current, next], current);
    // Next makes the old current History's 125th entry.
    expect(eventFor(next, { placement: 'NOW' }, longState)).toBe('fullsync+trailing');
    expect(eventFor(makeItem('X'), { shouldAddToQueue: true }, longState)).toBe('fullsync+trailing');
  });
});

describe('package exports', () => {
  it('exports the Now slot from the package index', () => {
    expect(queuePackage.placeOnWall).toBe(placeOnWall);
    expect(queuePackage.upNextStart).toBe(upNextStart);
    expect(queuePackage.capHistory).toBe(capHistory);
    expect(queuePackage.historyAndUpNextCount).toBe(historyAndUpNextCount);
    expect(queuePackage.isUpNextFull).toBe(isUpNextFull);
    expect(queuePackage.lineAfterDelta).toBe(lineAfterDelta);
    expect(queuePackage.normaliseHistoryCount).toBe(normaliseHistoryCount);
    expect(queuePackage.normaliseOrphanCurrent).toBe(normaliseOrphanCurrent);
    expect(queuePackage.isSameWallClimb).toBe(isSameWallClimb);
    expect(queuePackage.chooseQueueEvent).toBe(chooseQueueEvent);
    expect(queuePackage.reorderAcrossLine).toBe(reorderAcrossLine);
    expect(queuePackage.QUEUE_FULL).toBe(QUEUE_FULL);
    expect(queuePackage.clampNowSlotPayload).toBe(clampNowSlotPayload);
  });
});

describe('clampNowSlotPayload (the whole-queue payload a new phone sends)', () => {
  it('returns the same array when the payload fits', () => {
    const queue = [...historyItems(3), makeItem('X'), makeItem('U')];
    const clamped = clampNowSlotPayload(state(queue, queue[3]));
    expect(clamped.queue).toBe(queue);
    expect(clamped.historyCount).toBe(3);
  });

  it('keeps all 501 entries with a climb current: the climb on the wall is extra', () => {
    const upNext = Array.from({ length: 400 }, (_, index) => makeItem(`U${index}`));
    const current = makeItem('X');
    const queue = [...historyItems(100), current, ...upNext];
    expect(queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    const clamped = clampNowSlotPayload(state(queue, current));
    expect(clamped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(clamped.currentClimbQueueItem?.uuid).toBe('X');
  });

  it('trims History first, oldest first, and moves the line with it', () => {
    const upNext = Array.from({ length: 450 }, (_, index) => makeItem(`U${index}`));
    const queue = [...historyItems(60), ...upNext];
    const clamped = clampNowSlotPayload(state(queue, null, 60));
    expect(clamped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(clamped.queue[0].uuid).toBe('H10');
    expect(clamped.historyCount).toBe(50);
  });

  it('drops the tail of an Up next over the cap instead of sending a payload the server refuses', () => {
    const upNext = Array.from({ length: 510 }, (_, index) => makeItem(`U${index}`));
    const current = makeItem('X');
    const clamped = clampNowSlotPayload(state([current, ...upNext], current));
    expect(clamped.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(clamped.queue.at(-1)?.uuid).toBe('U499');
  });
});
