import { describe, expect, it } from 'vitest';
import { initialState, queueReducer } from '../reducer';
import type { Climb, ClimbQueueItem, QueueAction, QueueClimbReadTarget, QueueState } from '../types';

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    boardType: 'kilter',
    layoutId: 1,
    name: '',
    frames: '',
    setter_username: '',
    angle: 25,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '0',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeItem(climb = makeClimb(), uuid = 'slot-1'): ClimbQueueItem {
  return { uuid, climb, suggested: false };
}

function makeState(queue: ClimbQueueItem[], currentClimbQueueItem: ClimbQueueItem | null = null): QueueState {
  return { ...initialState({}), queue, currentClimbQueueItem };
}

function makeTarget(item: ClimbQueueItem, role: 'queue' | 'current' = 'queue', angle = 35): QueueClimbReadTarget {
  return { role, uuid: item.uuid, expectedClimb: item.climb, angle };
}

function hydrationAction(
  targets: QueueClimbReadTarget[],
  overrides: Partial<Climb> = {},
): Extract<QueueAction, { type: 'HYDRATE_CLIMBS' }> {
  return {
    type: 'HYDRATE_CLIMBS',
    payload: {
      climb: makeClimb({ name: 'A real climb', frames: 'p1r12', difficulty: 'V5', angle: 35, ...overrides }),
      targets,
      boardType: 'kilter',
      layoutId: 1,
      activeAngle: 35,
    },
  };
}

describe('guarded hydration of queue climb reads', () => {
  it('merges details into the latest slot without overwriting attribution, ticks or mirrors', () => {
    const original = makeItem(makeClimb({ mirrored: true }));
    const latest = {
      ...original,
      addedBy: 'Crew member',
      addedByUser: { id: 'crew-1', username: 'Crew member' },
      tickedBy: ['crew-2'],
      suggested: true,
    };
    const result = queueReducer(makeState([latest]), hydrationAction([makeTarget(original)]));
    expect(result.queue[0]).toEqual({
      ...latest,
      climb: { ...latest.climb, ...hydrationAction([]).payload.climb, mirrored: true },
    });
    expect(result.currentClimbQueueItem).toBeNull();
  });

  it('hydrates queued and current representations separately when only current was mirrored', () => {
    const queued = makeItem();
    const mirroredCurrent = { ...queued, climb: { ...queued.climb, mirrored: true } };
    const result = queueReducer(
      makeState([queued], mirroredCurrent),
      hydrationAction([makeTarget(queued), makeTarget(mirroredCurrent, 'current')]),
    );
    expect(result.queue[0].climb.name).toBe('A real climb');
    expect(result.queue[0].climb.mirrored).toBeUndefined();
    expect(result.currentClimbQueueItem?.climb.name).toBe('A real climb');
    expect(result.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

  it('hydrates a current-only target without adding a queue slot', () => {
    const current = makeItem();
    const result = queueReducer(makeState([], current), hydrationAction([makeTarget(current, 'current')]));
    expect(result.queue).toEqual([]);
    expect(result.currentClimbQueueItem?.climb.name).toBe('A real climb');
  });

  it('does not hydrate an untargeted current representation sharing the same slot UUID', () => {
    const queued = makeItem();
    const current = { ...queued, climb: { ...queued.climb, mirrored: true } };
    const result = queueReducer(makeState([queued], current), hydrationAction([makeTarget(queued)]));
    expect(result.queue[0].climb.name).toBe('A real climb');
    expect(result.currentClimbQueueItem).toBe(current);
  });

  it.each([
    ['a newly thin copy', () => makeItem(makeClimb())],
    ['a different climb in the slot', () => makeItem(makeClimb({ uuid: 'climb-2' }))],
    ['an already resolved climb', () => makeItem(makeClimb({ name: 'Newer content', frames: 'p2r12' }))],
    ['a renamed slot', () => makeItem(makeClimb(), 'slot-2')],
  ] as const)('rejects an answer addressed before %s', (_description, replacement) => {
    const requested = makeItem();
    const state = makeState([replacement()]);
    expect(queueReducer(state, hydrationAction([makeTarget(requested)]))).toBe(state);
  });

  it('does not resurrect a removed slot or current item', () => {
    const requested = makeItem();
    const state = makeState([]);
    expect(queueReducer(state, hydrationAction([makeTarget(requested), makeTarget(requested, 'current')]))).toBe(state);
  });

  it.each([{ boardType: 'tension' }, { layoutId: 2 }])('leaves foreign references thin: %j', (scope) => {
    const item = makeItem(makeClimb(scope));
    const state = makeState([item]);
    expect(queueReducer(state, hydrationAction([makeTarget(item)]))).toBe(state);
  });

  it.each([{ boardType: 'tension' }, { layoutId: 2 }, { angle: 40 }, { name: '' }, { frames: '' }, { uuid: 'other' }])(
    'rejects mismatched or incomplete returned details: %j',
    (response) => {
      const item = makeItem();
      const state = makeState([item]);
      expect(queueReducer(state, hydrationAction([makeTarget(item)], response))).toBe(state);
    },
  );

  it('hydrates history at its climbed angle without moving the current climb', () => {
    const history = makeItem(makeClimb({ angle: 20 }), 'history');
    const current = makeItem(makeClimb({ uuid: 'current' }), 'current');
    const result = queueReducer(
      makeState([history, current], current),
      hydrationAction([makeTarget(history, 'queue', 20)], { angle: 20 }),
    );
    expect(result.queue[0].climb.name).toBe('A real climb');
    expect(result.queue[0].climb.angle).toBe(20);
    expect(result.currentClimbQueueItem).toBe(current);
  });

  it('rejects a live-angle answer if navigation made its target history at another angle', () => {
    const history = makeItem();
    const current = makeItem(makeClimb({ uuid: 'current' }), 'current');
    const state = makeState([history, current], current);
    expect(queueReducer(state, hydrationAction([makeTarget(history)]))).toBe(state);
  });
});

describe('guarded regrade of queue climb reads', () => {
  const patch = {
    angle: 35,
    difficulty: 'V8',
    quality_average: '3.0',
    ascensionist_count: 10,
    benchmark_difficulty: null,
    boardseshDifficulty: null,
    boardseshConfidence: null,
  };

  function regradeAction(targets: QueueClimbReadTarget[]): QueueAction {
    return {
      type: 'REGRADE_CLIMBS',
      payload: { grades: { 'climb-1': patch }, targets, boardType: 'kilter', layoutId: 1 },
    };
  }

  it('regrades distinct queue and current objects while preserving their individual mirrors', () => {
    const queued = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12', boardseshDifficulty: 500 }));
    const current = { ...queued, climb: { ...queued.climb, mirrored: true } };
    const result = queueReducer(
      makeState([queued], current),
      regradeAction([makeTarget(queued), makeTarget(current, 'current')]),
    );
    expect(result.queue[0].climb).toMatchObject(patch);
    expect(result.currentClimbQueueItem?.climb).toMatchObject({ ...patch, mirrored: true });
    expect(result.queue[0].climb.mirrored).toBeUndefined();
  });

  it('rejects a grade response after its targeted climb object was replaced', () => {
    const requested = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12' }));
    const replacement = { ...requested, climb: { ...requested.climb, difficulty: 'Newer grade' } };
    const state = makeState([replacement]);
    expect(queueReducer(state, regradeAction([makeTarget(requested)]))).toBe(state);
  });

  it.each([{ name: '', frames: '' }, { boardType: 'tension' }, { layoutId: 2 }])(
    'does not regrade thin or foreign targets: %j',
    (overrides) => {
      const item = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12', ...overrides }));
      const state = makeState([item]);
      expect(queueReducer(state, regradeAction([makeTarget(item)]))).toBe(state);
    },
  );

  it('does not let a queued target implicitly regrade the current representation', () => {
    const queued = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12' }));
    const current = { ...queued, climb: { ...queued.climb, mirrored: true } };
    const result = queueReducer(makeState([queued], current), regradeAction([makeTarget(queued)]));
    expect(result.queue[0].climb.angle).toBe(35);
    expect(result.currentClimbQueueItem).toBe(current);
  });

  it('still preserves history when an earlier live-angle demand resolves', () => {
    const history = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12' }));
    const current = makeItem(makeClimb({ uuid: 'current' }), 'current');
    const state = makeState([history, current], current);
    expect(queueReducer(state, regradeAction([makeTarget(history)]))).toBe(state);
  });

  it('preserves the existing unguarded regrade interface for other callers', () => {
    const item = makeItem(makeClimb({ name: 'Climb', frames: 'p1r12' }));
    const result = queueReducer(makeState([item]), {
      type: 'REGRADE_CLIMBS',
      payload: { grades: { 'climb-1': patch } },
    });
    expect(result.queue[0].climb).toMatchObject(patch);
  });
});
