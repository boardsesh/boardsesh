/**
 * The reducer in now-slot mode (F3, #6666; docs/current-climb-outside-queue.md,
 * section 7). Legacy mode is covered by reducer.test.ts, whose cases all run
 * with `nowSlotMode` off and must stay green unchanged.
 */
import { describe, it, expect } from 'vitest';
import { queueReducer, initialState, heldHistoryCount } from '../reducer';
import { chooseQueueEvent, placeOnWall, reorderAcrossLine } from '../now-slot';
import { computeQueueStateHashOrdered } from '../state-hash';
import { legacyQueueReducer } from '../testing';
import type { ClimbQueueItem, QueueAction, QueueState } from '../types';

function item(uuid: string, climbUuid = `climb-${uuid}`, angle = 40): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name: `Climb ${climbUuid}`,
      frames: 'p1r12',
      angle,
      setter_username: 'setter',
      difficulty: '6a',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      ascensionist_count: 1,
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: null,
    suggested: false,
  };
}

const A = item('a');
const B = item('b');
const C = item('c');
const D = item('d');
const E = item('e');

function nowSlotState(overrides: Partial<QueueState> = {}): QueueState {
  const state = queueReducer(initialState({}), { type: 'SET_NOW_SLOT_MODE', payload: true });
  return { ...state, ...overrides };
}

function uuids(state: { queue: readonly ClimbQueueItem[] }): string[] {
  return state.queue.map(({ uuid }) => uuid);
}

function openLocally(
  state: QueueState,
  opened: ClimbQueueItem | null,
  extra: Partial<Extract<QueueAction, { type: 'DELTA_UPDATE_CURRENT_CLIMB' }>['payload']> = {},
): QueueState {
  return queueReducer(state, {
    type: 'DELTA_UPDATE_CURRENT_CLIMB',
    payload: { item: opened, shouldAddToQueue: true, ...extra },
  });
}

function serverCurrentChanged(state: QueueState, current: ClimbQueueItem | null): QueueState {
  return queueReducer(state, {
    type: 'DELTA_UPDATE_CURRENT_CLIMB',
    payload: { item: current, shouldAddToQueue: current != null, insertAfterCurrent: true, isServerEvent: true },
  });
}

describe('SET_NOW_SLOT_MODE', () => {
  it('derives the line from the current climb when it turns on, and clears it when it turns off', () => {
    const legacy = { ...initialState({}), queue: [A, B, C], currentClimbQueueItem: B };
    const on = queueReducer(legacy, { type: 'SET_NOW_SLOT_MODE', payload: true });
    expect(on.nowSlotMode).toBe(true);
    expect(on.historyCount).toBe(1);
    const off = queueReducer(on, { type: 'SET_NOW_SLOT_MODE', payload: false });
    expect(off.nowSlotMode).toBe(false);
    expect(off.historyCount).toBeNull();
  });

  it('returns the same state when the mode does not change', () => {
    const state = nowSlotState();
    expect(queueReducer(state, { type: 'SET_NOW_SLOT_MODE', payload: true })).toBe(state);
  });
  // A cold start whose restore runs before the flag resolves (no cached flag
  // values): the line waits in legacy mode and lands when the mode turns on.
  describe('a line restored before the mode is known', () => {
    const restore = (historyCount?: number) =>
      queueReducer(initialState({}), {
        type: 'UPDATE_QUEUE',
        payload: {
          queue: [A, B, C],
          currentClimbQueueItem: null,
          ...(historyCount === undefined ? {} : { historyCount }),
        },
      });

    it('is held, never read, in legacy mode, and applied when the mode turns on', () => {
      const legacy = restore(2);
      expect(legacy.historyCount).toBeNull();
      expect(heldHistoryCount(legacy)).toBe(2);
      const on = queueReducer(legacy, { type: 'SET_NOW_SLOT_MODE', payload: true });
      expect(on.historyCount).toBe(2);
      expect(on.heldHistoryLine).toBeNull();
    });

    it('is dropped when the queue changed before the mode turned on', () => {
      const reshaped = queueReducer(restore(2), { type: 'ADD_TO_QUEUE', payload: D });
      expect(heldHistoryCount(reshaped)).toBeNull();
      expect(queueReducer(reshaped, { type: 'SET_NOW_SLOT_MODE', payload: true }).historyCount).toBe(0);
    });

    it('is dropped when a climb went on the wall before the mode turned on', () => {
      const opened = queueReducer(restore(2), { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM', payload: A });
      expect(heldHistoryCount(opened)).toBeNull();
      expect(queueReducer(opened, { type: 'SET_NOW_SLOT_MODE', payload: true }).historyCount).toBe(0);
    });

    it('is replaced by a server snapshot and absent from a snapshot without a line', () => {
      const synced = queueReducer(restore(2), {
        type: 'INITIAL_QUEUE_DATA',
        payload: { queue: [A, B, C], currentClimbQueueItem: null },
      });
      expect(heldHistoryCount(synced)).toBeNull();
      expect(heldHistoryCount(restore())).toBeNull();
    });
  });
});

describe('local opens (placement NOW)', () => {
  it('moves a queued climb into Now instead of copying it: the issue example', () => {
    // A, B (current), C. Tap C in the logbook: a fresh uuid for the same climb.
    const state = nowSlotState({ queue: [A, B, C], currentClimbQueueItem: B, historyCount: 1 });
    const next = openLocally(state, item('c-prime', C.climb.uuid));
    expect(uuids(next)).toEqual(['a', 'b', 'c']);
    expect(next.currentClimbQueueItem?.uuid).toBe('c');
    expect(next.historyCount).toBe(2);
  });

  it('inserts a new climb at the Now slot, so Up next is unchanged', () => {
    const state = nowSlotState({ queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1 });
    const next = openLocally(state, item('x'));
    expect(uuids(next)).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(next.currentClimbQueueItem?.uuid).toBe('x');
    expect(next.historyCount).toBe(2);
  });

  it('a History row tap moves that one climb into Now (decision 3)', () => {
    const state = nowSlotState({ queue: [A, B, C, D], currentClimbQueueItem: C, historyCount: 2 });
    const next = openLocally(state, A, { placement: 'NOW' });
    expect(uuids(next)).toEqual(['b', 'c', 'a', 'd']);
    expect(next.currentClimbQueueItem?.uuid).toBe('a');
    expect(next.historyCount).toBe(2);
  });

  it('ignores shouldAddToQueue: false, so no orphan can form', () => {
    const state = nowSlotState({ queue: [A, B], currentClimbQueueItem: A, historyCount: 0 });
    const next = openLocally(state, item('x'), { shouldAddToQueue: false });
    expect(uuids(next)).toEqual(['a', 'x', 'b']);
    expect(next.currentClimbQueueItem?.uuid).toBe('x');
  });

  it('never prunes suggested climbs after the new current climb', () => {
    const suggested = { ...item('s'), suggested: true };
    const state = nowSlotState({ queue: [A, suggested], currentClimbQueueItem: A, historyCount: 0 });
    const next = openLocally(state, item('x'), {
      playlistSuggestionSource: {
        playlistUuid: 'p',
        climbs: [],
        activatedClimbUuid: 'x',
      } as unknown as NonNullable<QueueState['playlistSuggestionSource']>,
    });
    expect(uuids(next)).toEqual(['a', 'x', 's']);
  });

  it('records the correlation id so the echo is suppressed', () => {
    const state = nowSlotState({ queue: [A], currentClimbQueueItem: A, historyCount: 0 });
    const next = openLocally(state, item('x'), { correlationId: 'corr-1' });
    expect(next.pendingCurrentClimbUpdates).toEqual(['corr-1']);
    const echoed = queueReducer(next, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: next.currentClimbQueueItem, isServerEvent: true, serverCorrelationId: 'corr-1' },
    });
    expect(echoed.pendingCurrentClimbUpdates).toEqual([]);
    expect(uuids(echoed)).toEqual(uuids(next));
  });

  it('a local clear keeps the climb as the last History entry', () => {
    const state = nowSlotState({ queue: [A, B, C], currentClimbQueueItem: B, historyCount: 1 });
    const next = openLocally(state, null);
    expect(uuids(next)).toEqual(['a', 'b', 'c']);
    expect(next.currentClimbQueueItem).toBeNull();
    expect(next.historyCount).toBe(2);
  });
});

describe('Previous on the queue walk and Replay from here (placement STEP)', () => {
  const history = [A, B, C];

  it('steps back into Up next: the array is unchanged and the hash matches the server', () => {
    // History [A B C], D current, Up next [E]. Replay from here on B.
    const state = nowSlotState({ queue: [...history, D, E], currentClimbQueueItem: D, historyCount: 3 });
    const next = openLocally(state, B, { placement: 'STEP' });
    expect(uuids(next)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(next.currentClimbQueueItem?.uuid).toBe('b');
    expect(next.historyCount).toBe(1);

    // The server runs the same rule, and a pointer move is what it publishes.
    const serverBefore = { queue: state.queue, currentClimbQueueItem: D, historyCount: 3 };
    const serverAfter = placeOnWall(serverBefore, B, 'STEP');
    expect(chooseQueueEvent(serverBefore, { item: B, placement: 'STEP' }, serverAfter)).toBe('pointer');
    expect(computeQueueStateHashOrdered(next.queue, next.currentClimbQueueItem?.uuid ?? null)).toBe(
      computeQueueStateHashOrdered(serverAfter.queue, serverAfter.currentClimbQueueItem?.uuid ?? null),
    );
  });

  it('with nothing current, STEP onto an older History entry moves it into Now', () => {
    const state = nowSlotState({ queue: [...history, E], currentClimbQueueItem: null, historyCount: 3 });
    const next = openLocally(state, A, { placement: 'STEP' });
    expect(uuids(next)).toEqual(['b', 'c', 'a', 'e']);
    expect(next.currentClimbQueueItem?.uuid).toBe('a');
    expect(next.historyCount).toBe(2);
  });
});

describe('server CurrentClimbChanged', () => {
  it('only moves the pointer, never re-running placement', () => {
    const state = nowSlotState({ queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1 });
    const next = serverCurrentChanged(state, A);
    expect(uuids(next)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.currentClimbQueueItem?.uuid).toBe('a');
    expect(next.historyCount).toBe(0);
  });

  it('inserts a missing climb at the Now slot, like today', () => {
    const state = nowSlotState({ queue: [A, B, C], currentClimbQueueItem: B, historyCount: 1 });
    const next = serverCurrentChanged(state, item('x'));
    expect(uuids(next)).toEqual(['a', 'b', 'x', 'c']);
    expect(next.historyCount).toBe(2);
  });

  it('inserts at the line with nothing current', () => {
    const state = nowSlotState({ queue: [A, B, C], currentClimbQueueItem: null, historyCount: 2 });
    const next = serverCurrentChanged(state, item('x'));
    expect(uuids(next)).toEqual(['a', 'b', 'x', 'c']);
    expect(next.historyCount).toBe(2);
  });

  it('a null current climb keeps it as History', () => {
    const state = nowSlotState({ queue: [A, B, C], currentClimbQueueItem: B, historyCount: 1 });
    const next = serverCurrentChanged(state, null);
    expect(next.currentClimbQueueItem).toBeNull();
    expect(next.historyCount).toBe(2);
  });
});

describe('deltas with nothing current move the line', () => {
  const start = () => nowSlotState({ queue: [A, C, D], currentClimbQueueItem: null, historyCount: 1 });

  it('an add below the line raises it; an add at the line leaves it', () => {
    const atHead = queueReducer(start(), { type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: item('x'), position: 0 } });
    expect(uuids(atHead)).toEqual(['x', 'a', 'c', 'd']);
    expect(atHead.historyCount).toBe(2);
    const atLine = queueReducer(start(), { type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: item('x'), position: 1 } });
    expect(uuids(atLine)).toEqual(['a', 'x', 'c', 'd']);
    expect(atLine.historyCount).toBe(1);
    const appended = queueReducer(start(), { type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: item('x') } });
    expect(appended.historyCount).toBe(1);
  });

  it('a removal below the line lowers it', () => {
    const next = queueReducer(start(), { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: 'a' } });
    expect(next.historyCount).toBe(0);
  });

  it('removing the current climb sets the line to its index', () => {
    const state = nowSlotState({ queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1 });
    const next = queueReducer(state, { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: 'b' } });
    expect(next.currentClimbQueueItem).toBeNull();
    expect(next.historyCount).toBe(1);
  });

  it('a server reorder across the line is applied as given and moves the line by one', () => {
    // History entry A dragged below the line joins Up next.
    const down = queueReducer(start(), {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'a', oldIndex: 0, newIndex: 2 },
    });
    expect(uuids(down)).toEqual(['c', 'd', 'a']);
    expect(down.historyCount).toBe(0);
    // An Up next entry applied above the line (an old phone's unclamped drag
    // outside the percent) is filed under History.
    const up = queueReducer(start(), {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'd', oldIndex: 2, newIndex: 0 },
    });
    expect(uuids(up)).toEqual(['d', 'a', 'c']);
    expect(up.historyCount).toBe(2);
  });

  it("a new phone's own drag above the line is clamped to the head of Up next before it is dispatched", () => {
    const state = start();
    const clamped = reorderAcrossLine(state, 2, 0);
    expect(clamped?.clamped).toBe(true);
    expect(clamped?.newIndex).toBe(1);
    const next = queueReducer(state, {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'd', oldIndex: 2, newIndex: clamped?.newIndex ?? 0 },
    });
    expect(uuids(next)).toEqual(['a', 'd', 'c']);
    expect(next.historyCount).toBe(1);
  });

  it('CLEAR_QUEUE resets the line to 0', () => {
    expect(queueReducer(start(), { type: 'CLEAR_QUEUE' }).historyCount).toBe(0);
  });
});

describe('INITIAL_QUEUE_DATA and UPDATE_QUEUE', () => {
  it('take historyCount from the payload with nothing current', () => {
    const next = queueReducer(nowSlotState(), {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [A, B, C], currentClimbQueueItem: null, historyCount: 2 },
    });
    expect(next.historyCount).toBe(2);
    const restored = queueReducer(nowSlotState(), {
      type: 'UPDATE_QUEUE',
      payload: { queue: [A, B, C], currentClimbQueueItem: null, historyCount: 9999 },
    });
    expect(restored.historyCount).toBe(3);
  });

  it('derive the line from the current climb, ignoring a sent value', () => {
    const next = queueReducer(nowSlotState(), {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [A, B, C], currentClimbQueueItem: B, historyCount: 0 },
    });
    expect(next.historyCount).toBe(1);
  });

  it('keep an orphan current climb as received and insert nothing', () => {
    const orphan = item('x');
    const next = queueReducer(nowSlotState(), {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [A, B, C], currentClimbQueueItem: orphan, historyCount: 1 },
    });
    expect(uuids(next)).toEqual(['a', 'b', 'c']);
    expect(next.currentClimbQueueItem?.uuid).toBe('x');
    expect(next.historyCount).toBe(1);
    // The hash covers queue uuids plus the current uuid, exactly as received.
    expect(computeQueueStateHashOrdered(next.queue, 'x')).toBe(computeQueueStateHashOrdered([A, B, C], 'x'));
  });

  it('legacy mode stores null even when a FullSync carries 1', () => {
    const legacy = initialState({});
    const next = queueReducer(legacy, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [A, B, C], currentClimbQueueItem: null, historyCount: 1 },
    });
    expect(next.historyCount).toBeNull();
  });
});

describe('a move the reconnect snapshot predates (#6814)', () => {
  const SEEN = 5;

  function onWall(): QueueState {
    // History [A], B on the wall, Up next [C, D], last heard at sequence SEEN.
    return nowSlotState({
      queue: [A, B, C, D],
      currentClimbQueueItem: B,
      historyCount: 1,
      serverSequence: SEEN,
      serverSequenceSessionId: 'session-1',
    });
  }

  function staleSnapshot(state: QueueState): QueueState {
    return queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      serverSequence: SEEN,
      payload: { queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1, sessionId: 'session-1', live: true },
    });
  }

  it('records the placement with the move', () => {
    const moved = openLocally(onWall(), D, { correlationId: 'corr-1', sessionId: 'session-1', placement: 'NOW' });
    expect(moved.unconfirmedMove).toMatchObject({ itemUuid: 'd', placement: 'NOW', movedOff: ['b'] });
  });

  it('replays the move with placeOnWall, the rule the server runs when it lands', () => {
    const moved = openLocally(onWall(), D, { correlationId: 'corr-1', sessionId: 'session-1', placement: 'NOW' });
    const kept = staleSnapshot(moved);
    const serverAfterLanding = placeOnWall(
      { queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1 },
      D,
      'NOW',
    );
    expect(kept.currentClimbQueueItem?.uuid).toBe('d');
    expect(uuids(kept)).toEqual(serverAfterLanding.queue.map(({ uuid }) => uuid));
    expect(kept.historyCount).toBe(serverAfterLanding.historyCount);
    // Same shape as this phone had before the snapshot: nothing jumped back.
    expect(uuids(kept)).toEqual(uuids(moved));
    expect(kept.historyCount).toBe(moved.historyCount);
    expect(kept.unconfirmedMove?.correlationId).toBe('corr-1');
  });

  it('takes the snapshot once the session moved on', () => {
    const moved = openLocally(onWall(), D, { correlationId: 'corr-1', sessionId: 'session-1', placement: 'NOW' });
    const taken = queueReducer(moved, {
      type: 'INITIAL_QUEUE_DATA',
      serverSequence: SEEN + 1,
      payload: { queue: [A, B, C, D], currentClimbQueueItem: B, historyCount: 1, sessionId: 'session-1', live: true },
    });
    expect(taken.currentClimbQueueItem?.uuid).toBe('b');
    expect(uuids(taken)).toEqual(['a', 'b', 'c', 'd']);
    expect(taken.historyCount).toBe(1);
    expect(taken.unconfirmedMove).toBeNull();
  });
});

describe('History trim (section 5)', () => {
  const longHistory = Array.from({ length: 125 }, (_, index) => item(`h${index}`));

  it('never trims in a session', () => {
    const state = nowSlotState({ queue: [...longHistory, E], currentClimbQueueItem: null, historyCount: 125 });
    const next = openLocally(state, item('x'));
    expect(next.queue).toHaveLength(127);
  });

  it('trims solo at 125 to the newest 100', () => {
    const state = nowSlotState({
      queue: [...longHistory.slice(0, 124), A, E],
      currentClimbQueueItem: A,
      historyCount: 124,
    });
    const next = openLocally(state, item('x'), { capHistory: true });
    // History was 124 + A = 125 once X went on the wall.
    expect(next.historyCount).toBe(100);
    expect(next.queue[99].uuid).toBe('a');
    expect(next.currentClimbQueueItem?.uuid).toBe('x');
    expect(next.queue.at(-1)?.uuid).toBe('e');
  });
});

describe('HYDRATE_CLIMBS and REGRADE_CLIMBS freeze History with nothing current', () => {
  it('REGRADE_CLIMBS leaves History at its climbed-at angle', () => {
    const state = nowSlotState({ queue: [A, C], currentClimbQueueItem: null, historyCount: 1 });
    const patch = (climbUuid: string) => ({
      [climbUuid]: {
        angle: 45,
        difficulty: '7a',
        quality_average: '3',
        ascensionist_count: 2,
        benchmark_difficulty: null,
      },
    });
    const next = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: { grades: { ...patch(A.climb.uuid), ...patch(C.climb.uuid) } },
    });
    expect(next.queue[0].climb.angle).toBe(40);
    expect(next.queue[1].climb.angle).toBe(45);
  });

  it('legacy mode with nothing current still re-grades everything, as today', () => {
    const state = { ...initialState({}), queue: [A, C] };
    const next = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          [A.climb.uuid]: {
            angle: 45,
            difficulty: '7a',
            quality_average: '3',
            ascensionist_count: 2,
            benchmark_difficulty: null,
          },
        },
      },
    });
    expect(next.queue[0].climb.angle).toBe(45);
  });
});

describe('legacy mode is today’s reducer', () => {
  it('copies a queued climb on a logbook tap, matching the frozen 2026-10 reducer', () => {
    const state = { ...initialState({}), queue: [A, B, C], currentClimbQueueItem: B };
    const action = {
      type: 'DELTA_UPDATE_CURRENT_CLIMB' as const,
      payload: { item: item('c-prime', C.climb.uuid), shouldAddToQueue: true, insertAfterCurrent: true },
    };
    const live = queueReducer(state, action);
    const frozen = legacyQueueReducer(
      { queue: state.queue, currentClimbQueueItem: state.currentClimbQueueItem, pendingCurrentClimbUpdates: [] },
      action,
    );
    expect(uuids(live)).toEqual(['a', 'b', 'c-prime', 'c']);
    expect(uuids(live)).toEqual(uuids(frozen));
    expect(live.historyCount).toBeNull();
  });
});
