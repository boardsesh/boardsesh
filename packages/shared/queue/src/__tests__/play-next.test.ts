import { describe, it, expect } from 'vitest';
import { planPlayNext, playNextInsertPosition } from '../play-next';
import type { Climb, ClimbQueue, ClimbQueueItem } from '../types';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    setter_username: 'setter',
    frames: 'p1r1',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

/** `queueItemUuid:climbUuid` — the two are distinct on purpose, so a test that
 *  matches the wrong one is visible in the assertion. */
function makeItem(queueItemUuid: string, climbUuid: string = queueItemUuid): ClimbQueueItem {
  return { uuid: `q-${queueItemUuid}`, climb: makeClimb(`c-${climbUuid}`) };
}

function buildQueue(...uuids: string[]): ClimbQueue {
  return uuids.map((uuid) => makeItem(uuid));
}

/** Apply a `move` plan exactly the way the reducer and the backend resolver do. */
function applyMove(queue: ClimbQueue, oldIndex: number, newIndex: number): string[] {
  const next = [...queue];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next.map((item) => item.uuid);
}

describe('planPlayNext', () => {
  it('inserts at 0 when the queue is empty', () => {
    expect(planPlayNext([], null, { climbUuid: 'c-x' })).toEqual({ kind: 'insert', position: 0 });
  });

  it('inserts at the FRONT (not the end) when nothing is current', () => {
    const queue = buildQueue('a', 'b', 'c');
    expect(planPlayNext(queue, null, { climbUuid: 'c-x' })).toEqual({ kind: 'insert', position: 0 });
  });

  it('inserts directly after the current climb', () => {
    const queue = buildQueue('a', 'b', 'c', 'd');
    expect(planPlayNext(queue, queue[1], { climbUuid: 'c-x' })).toEqual({ kind: 'insert', position: 2 });
  });

  it('inserts at 0 when the current climb is not in the queue (playlist peek / removed slot)', () => {
    const queue = buildQueue('a', 'b');
    const orphanCurrent = makeItem('gone');
    expect(planPlayNext(queue, orphanCurrent, { climbUuid: 'c-x' })).toEqual({ kind: 'insert', position: 0 });
  });

  it('moves a climb from later in the queue up to the slot after current', () => {
    const queue = buildQueue('a', 'b', 'c', 'd');
    // current = b (index 1), target = d (index 3)
    const plan = planPlayNext(queue, queue[1], { climbUuid: 'c-d' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-d', oldIndex: 3, newIndex: 2 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-a', 'q-b', 'q-d', 'q-c']);
  });

  // The direction-aware branch. A flat `currentIndex + 1` lands the item one
  // slot too late, because the splice-remove shifts the current climb down one.
  it('moves a HISTORY climb (before current) to the slot immediately after current', () => {
    const queue = buildQueue('a', 'b', 'c', 'd');
    // current = c (index 2), target = a (index 0)
    const plan = planPlayNext(queue, queue[2], { climbUuid: 'c-a' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-a', oldIndex: 0, newIndex: 2 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    // a must land immediately AFTER c, not after d.
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-b', 'q-c', 'q-a', 'q-d']);
  });

  // The ONE move branch that does not route through `playNextInsertPosition`:
  // `planPlayNext` decides "after current" itself via the `currentIndex === -1`
  // arm. Both say 0 today; nothing else pins that they agree, so if the helper's
  // orphan branch ever changes this test is what catches the drift.
  it('moves an already-queued climb to the head when the current climb is an orphan', () => {
    const queue = buildQueue('a', 'b', 'c');
    const orphanCurrent = makeItem('gone');
    const plan = planPlayNext(queue, orphanCurrent, { climbUuid: 'c-c' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-c', oldIndex: 2, newIndex: 0 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-c', 'q-a', 'q-b']);
  });

  // oldIndex === currentIndex - 1: the tightest backward move there is, and the
  // one where an off-by-one would be least visible.
  it('moves the row immediately BEFORE current to immediately after it', () => {
    const queue = buildQueue('a', 'b', 'c');
    const plan = planPlayNext(queue, queue[2], { climbUuid: 'c-b' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-b', oldIndex: 1, newIndex: 2 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-a', 'q-c', 'q-b']);
  });

  it('reports already-next when the target already sits right after current', () => {
    const queue = buildQueue('a', 'b', 'c');
    expect(planPlayNext(queue, queue[0], { climbUuid: 'c-b' })).toEqual({
      kind: 'unchanged',
      reason: 'already-next',
    });
  });

  it('reports already-next for the head of the queue when nothing is current', () => {
    const queue = buildQueue('a', 'b');
    expect(planPlayNext(queue, null, { climbUuid: 'c-a' })).toEqual({
      kind: 'unchanged',
      reason: 'already-next',
    });
  });

  it('reports is-current when the target IS the climb on the wall', () => {
    const queue = buildQueue('a', 'b', 'c');
    expect(planPlayNext(queue, queue[1], { climbUuid: 'c-b' })).toEqual({
      kind: 'unchanged',
      reason: 'is-current',
    });
  });

  it('prefers the copy AFTER current when the same climb is queued twice', () => {
    // Same climb uuid in slots 0 and 3; current sits at 1.
    const queue: ClimbQueue = [makeItem('dupe-early', 'x'), makeItem('b'), makeItem('c'), makeItem('dupe-late', 'x')];
    const plan = planPlayNext(queue, queue[1], { climbUuid: 'c-x' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-dupe-late', oldIndex: 3, newIndex: 2 });
  });

  it('falls back to the first match when every copy is before current', () => {
    const queue: ClimbQueue = [makeItem('dupe-early', 'x'), makeItem('dupe-mid', 'x'), makeItem('c')];
    const plan = planPlayNext(queue, queue[2], { climbUuid: 'c-x' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-dupe-early', oldIndex: 0, newIndex: 2 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    // Current sits at the tail, so "after current" is the last slot.
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-dupe-mid', 'q-c', 'q-dupe-early']);
  });

  it('honours an explicit queueItemUuid over a climb-uuid duplicate elsewhere', () => {
    const queue: ClimbQueue = [makeItem('dupe-early', 'x'), makeItem('b'), makeItem('c'), makeItem('dupe-late', 'x')];
    const plan = planPlayNext(queue, queue[1], { queueItemUuid: 'q-dupe-early', climbUuid: 'c-x' });
    expect(plan).toEqual({ kind: 'move', uuid: 'q-dupe-early', oldIndex: 0, newIndex: 1 });
    if (plan.kind !== 'move') throw new Error('expected a move');
    expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-b', 'q-dupe-early', 'q-c', 'q-dupe-late']);
  });

  it('inserts when an explicit queueItemUuid no longer exists (slot removed mid-gesture)', () => {
    const queue = buildQueue('a', 'b');
    const plan = planPlayNext(queue, queue[0], { queueItemUuid: 'q-gone', climbUuid: 'c-gone' });
    expect(plan).toEqual({ kind: 'insert', position: 1 });
  });
});

// The commit path calls this directly for a brand-new item, so it must be total —
// never falling back to an append the climber did not ask for.
describe('playNextInsertPosition', () => {
  it('returns 0 for an empty queue', () => {
    expect(playNextInsertPosition([], null)).toBe(0);
  });

  it('returns 0 when nothing is current', () => {
    expect(playNextInsertPosition(buildQueue('a', 'b'), null)).toBe(0);
  });

  it('returns 0 when the current climb is not in the queue', () => {
    expect(playNextInsertPosition(buildQueue('a', 'b'), makeItem('gone'))).toBe(0);
  });

  it('returns the slot after the current climb', () => {
    const queue = buildQueue('a', 'b', 'c');
    expect(playNextInsertPosition(queue, queue[1])).toBe(2);
  });

  it('agrees with planPlayNext for a climb that is not queued', () => {
    const queue = buildQueue('a', 'b', 'c');
    const plan = planPlayNext(queue, queue[1], { climbUuid: 'c-not-queued' });
    expect(plan).toEqual({ kind: 'insert', position: playNextInsertPosition(queue, queue[1]) });
  });
});

describe('Play next with nothing current (F3 now-slot mode)', () => {
  it('a new climb lands at the line, not at 0', () => {
    const queue = buildQueue('h1', 'h2', 'h3', 'u1');
    expect(playNextInsertPosition(queue, null, 3)).toBe(3);
    expect(planPlayNext(queue, null, { climbUuid: 'c-new' }, 3)).toEqual({ kind: 'insert', position: 3 });
  });

  it('legacy mode (no historyCount) still lands at 0', () => {
    const queue = buildQueue('h1', 'u1');
    expect(playNextInsertPosition(queue, null, null)).toBe(0);
    expect(planPlayNext(queue, null, { climbUuid: 'c-new' })).toEqual({ kind: 'insert', position: 0 });
  });

  it('prefers the Up next copy of a climb that is also in History', () => {
    const queue = [makeItem('h1', 'dup'), makeItem('h2'), makeItem('u1'), makeItem('u2', 'dup')];
    const plan = planPlayNext(queue, null, { climbUuid: 'c-dup' }, 2);
    expect(plan).toEqual({ kind: 'move', uuid: 'q-u2', oldIndex: 3, newIndex: 2 });
    if (plan.kind === 'move')
      expect(applyMove(queue, plan.oldIndex, plan.newIndex)).toEqual(['q-h1', 'q-h2', 'q-u2', 'q-u1']);
  });

  it('an Up next head is already next', () => {
    const queue = buildQueue('h1', 'u1', 'u2');
    expect(planPlayNext(queue, null, { climbUuid: 'c-u1' }, 1)).toEqual({ kind: 'unchanged', reason: 'already-next' });
  });

  it('a History entry becomes the head of Up next, in one whole-queue write', () => {
    const queue = buildQueue('h1', 'h2', 'u1');
    expect(planPlayNext(queue, null, { queueItemUuid: 'q-h1', climbUuid: 'c-h1' }, 2)).toEqual({
      kind: 'replace',
      uuid: 'q-h1',
      oldIndex: 0,
      queue: [queue[1], queue[0], queue[2]],
      historyCount: 1,
    });
  });

  it('a History entry with Up next empty lands at the end, never at an out-of-range index', () => {
    const queue = buildQueue('h1', 'h2');
    const plan = planPlayNext(queue, null, { queueItemUuid: 'q-h1', climbUuid: 'c-h1' }, 2);
    expect(plan).toEqual({
      kind: 'replace',
      uuid: 'q-h1',
      oldIndex: 0,
      queue: [queue[1], queue[0]],
      historyCount: 1,
    });
  });

  it('the last History entry also moves across the line', () => {
    const queue = buildQueue('h1', 'h2', 'u1');
    expect(planPlayNext(queue, null, { climbUuid: 'c-h2' }, 2)).toEqual({
      kind: 'replace',
      uuid: 'q-h2',
      oldIndex: 1,
      queue: [queue[0], queue[1], queue[2]],
      historyCount: 1,
    });
  });

  it('a History entry with a climb current still moves with one reorder', () => {
    const queue = buildQueue('h1', 'now', 'u1');
    expect(planPlayNext(queue, queue[1], { climbUuid: 'c-h1' }, 1)).toEqual({
      kind: 'move',
      uuid: 'q-h1',
      oldIndex: 0,
      newIndex: 1,
    });
  });
});
