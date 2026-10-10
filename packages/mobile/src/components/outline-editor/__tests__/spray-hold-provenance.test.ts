/**
 * Training provenance (SW-20, #5471): which detector find an AUTO hold started
 * as, and what the climber did with it. Covers the seed that stamps the origin,
 * every reducer action that moves `autoReview`, and what the write plan sends.
 */
import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import {
  initialSprayEditorState,
  raiseAutoReview,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorHold,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { buildEditorSeed, type SeedableWall } from '../spray-hold-seed';
import { buildSprayHoldWritePlan, prepareCommit } from '../spray-hold-writes';
import type { SprayHoldCandidate } from '../spray-hold-editor-types';
import { SPRAY_MAYBE_FLOOR, SPRAY_ON_CUTOFF } from '../spray-hold-tools';

const CONFIDENT = SPRAY_ON_CUTOFF + 0.1;
const UNSURE = (SPRAY_ON_CUTOFF + SPRAY_MAYBE_FLOOR) / 2;
const BELOW_FLOOR = SPRAY_MAYBE_FLOOR - 0.1;
const RUN = 'detection-7';

const EMPTY_WALL: SeedableWall = { wallUuid: 'wall-1', version: 1, versionId: 1, holds: [] };

function find(index: number, confidence: number, overrides: Partial<SprayHoldCandidate> = {}): SprayHoldCandidate {
  return { cx: 100 + index * 50, cy: 200, r: 20, confidence, detectionId: RUN, index, ...overrides };
}

function seeded(candidates: SprayHoldCandidate[], wall: SeedableWall = EMPTY_WALL): SprayEditorState {
  return sprayEditorReducer(initialSprayEditorState(), {
    type: 'LOAD',
    holds: buildEditorSeed(wall, candidates, true),
  });
}

function run(state: SprayEditorState, ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, state);
}

/** The seeded hold that started as find `index`. */
function holdFor(state: SprayEditorState, index: number): SprayEditorHold {
  const hold = Object.values(state.holds).find((candidate) => candidate.origin?.candidateIndex === index);
  if (!hold) throw new Error(`no hold for find ${index}`);
  return hold;
}

function wireFor(state: SprayEditorState, index: number) {
  const { plan } = prepareCommit(state, IDENTITY_HOMOGRAPHY);
  const position = plan.writtenIds.indexOf(holdFor(state, index).id);
  return position === -1 ? undefined : plan.upsert[position];
}

describe('buildEditorSeed provenance', () => {
  it("stamps each find's own run and index, not its loop position", () => {
    // Find 1 is below the floor and skipped, so a loop counter would call find 2 "1".
    const state = seeded([find(0, CONFIDENT), find(1, BELOW_FLOOR), find(2, UNSURE)]);
    const holds = Object.values(state.holds);
    expect(holds).toHaveLength(2);
    expect(
      holds.map((hold) => hold.origin).sort((a, b) => (a?.candidateIndex ?? 0) - (b?.candidateIndex ?? 0)),
    ).toEqual([
      { detectionId: RUN, candidateIndex: 0 },
      { detectionId: RUN, candidateIndex: 2 },
    ]);
    expect(holdFor(state, 2).confidence).toBe(UNSURE);
  });

  it('leaves the origin off a find with no stamp, and off stored holds', () => {
    const wall: SeedableWall = { ...EMPTY_WALL, holds: [{ id: 4, cx: 1, cy: 2, r: 3, source: 'AUTO' }] };
    const holds = buildEditorSeed(wall, [{ cx: 5, cy: 6, r: 7, confidence: CONFIDENT }], true);
    for (const hold of holds) {
      expect(hold).not.toHaveProperty('origin');
      expect(hold).not.toHaveProperty('autoReview');
    }
  });
});

describe('autoReview through the reducer', () => {
  it('Publish accepts an untouched confident find as ACCEPTED', () => {
    expect(wireFor(seeded([find(0, CONFIDENT)]), 0)).toEqual({
      cx: 100,
      cy: 200,
      r: 20,
      outline: null,
      source: 'AUTO',
      confidence: CONFIDENT,
      autoReview: 'ACCEPTED',
      originDetectionId: RUN,
      originCandidateIndex: 0,
    });
  });

  it('a maybe the climber taps on is CONFIRMED', () => {
    const start = seeded([find(0, UNSURE)]);
    const state = run(start, { type: 'TOGGLE_HOLD', id: holdFor(start, 0).id });
    expect(holdFor(state, 0).autoReview).toBe('CONFIRMED');
    expect(wireFor(state, 0)).toMatchObject({ autoReview: 'CONFIRMED', originCandidateIndex: 0 });
  });

  it('a confident find switched off then back on is CONFIRMED', () => {
    const start = seeded([find(0, CONFIDENT)]);
    const id = holdFor(start, 0).id;
    const state = run(start, { type: 'TOGGLE_HOLD', id }, { type: 'TOGGLE_HOLD', id });
    expect(holdFor(state, 0).autoReview).toBe('CONFIRMED');
  });

  it('a switched-off find is never written', () => {
    const start = seeded([find(0, CONFIDENT)]);
    const state = run(start, { type: 'SWITCH_OFF', id: holdFor(start, 0).id });
    expect(wireFor(state, 0)).toBeUndefined();
  });

  it('Keep all maybes marks every maybe ACCEPTED', () => {
    const state = run(seeded([find(0, UNSURE), find(1, UNSURE)]), { type: 'KEEP_MAYBES' });
    expect(holdFor(state, 0).autoReview).toBe('ACCEPTED');
    expect(holdFor(state, 1).autoReview).toBe('ACCEPTED');
  });

  it.each<[string, (id: number) => SprayEditorAction]>([
    ['MOVE_HOLD', (id) => ({ type: 'MOVE_HOLD', id, cx: 999, cy: 888 })],
    ['RESIZE_HOLD', (id) => ({ type: 'RESIZE_HOLD', id, r: 55 })],
    [
      'SET_OUTLINE',
      (id) => ({ type: 'SET_OUTLINE', id, geometry: { cx: 100, cy: 200, r: 22, outline: [1, 0, 0, 1, -1, 0] } }),
    ],
  ])('%s on a find makes it EDITED', (_name, action) => {
    const start = seeded([find(0, CONFIDENT)]);
    const state = run(start, action(holdFor(start, 0).id));
    expect(holdFor(state, 0).autoReview).toBe('EDITED');
    expect(wireFor(state, 0)).toMatchObject({ autoReview: 'EDITED', originDetectionId: RUN, originCandidateIndex: 0 });
  });

  it('never downgrades: an edited find stays EDITED through toggles, Keep all maybes and Publish', () => {
    const start = seeded([find(0, UNSURE)]);
    const id = holdFor(start, 0).id;
    const state = run(
      start,
      { type: 'RESIZE_HOLD', id, r: 40 },
      { type: 'TOGGLE_HOLD', id },
      { type: 'TOGGLE_HOLD', id },
      { type: 'KEEP_MAYBES' },
    );
    expect(holdFor(state, 0).autoReview).toBe('EDITED');
    expect(wireFor(state, 0)?.autoReview).toBe('EDITED');
  });

  it('a confirmed maybe stays CONFIRMED through Publish', () => {
    const start = seeded([find(0, UNSURE)]);
    const state = run(start, { type: 'TOGGLE_HOLD', id: holdFor(start, 0).id });
    expect(prepareCommit(state, IDENTITY_HOMOGRAPHY).state.holds[holdFor(start, 0).id].autoReview).toBe('CONFIRMED');
  });

  it('edit, undo, redo carries the review with each snapshot', () => {
    const start = seeded([find(0, CONFIDENT)]);
    const id = holdFor(start, 0).id;
    const edited = run(start, { type: 'MOVE_HOLD', id, cx: 500, cy: 500 });
    const undone = run(edited, { type: 'UNDO' });
    expect(undone.holds[id].autoReview).toBeUndefined();
    expect(undone.holds[id].origin).toEqual({ detectionId: RUN, candidateIndex: 0 });
    expect(wireFor(undone, 0)?.autoReview).toBe('ACCEPTED');
    const redone = run(undone, { type: 'REDO' });
    expect(redone.holds[id].autoReview).toBe('EDITED');
    expect(wireFor(redone, 0)).toMatchObject({ cx: 500, autoReview: 'EDITED', originCandidateIndex: 0 });
  });

  it('MERGE clears origin and review on the survivor and sends it as MANUAL', () => {
    const start = seeded([find(0, CONFIDENT), find(3, CONFIDENT, { cx: 120 })]);
    const first = holdFor(start, 0).id;
    const second = holdFor(start, 3).id;
    const merged = run(start, { type: 'MERGE', ids: [first, second] });
    const survivor = Object.values(merged.holds);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).not.toHaveProperty('origin');
    expect(survivor[0]).not.toHaveProperty('autoReview');
    const { plan } = prepareCommit(merged, IDENTITY_HOMOGRAPHY);
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0]).toMatchObject({ source: 'MANUAL' });
    expect(plan.upsert[0]).not.toHaveProperty('autoReview');
    expect(plan.upsert[0]).not.toHaveProperty('originDetectionId');
    expect(plan.upsert[0]).not.toHaveProperty('originCandidateIndex');
  });

  it('ADD_HOLD and hand-drawn edits carry no provenance', () => {
    const added = run(initialSprayEditorState(), {
      type: 'ADD_HOLD',
      geometry: { cx: 1, cy: 2, r: 3, outline: null },
    });
    const id = Object.values(added.holds)[0].id;
    const moved = run(added, { type: 'MOVE_HOLD', id, cx: 9, cy: 9 });
    expect(moved.holds[id]).not.toHaveProperty('autoReview');
    expect(buildSprayHoldWritePlan(moved, IDENTITY_HOMOGRAPHY).upsert[0]).toEqual({
      cx: 9,
      cy: 9,
      r: 3,
      outline: null,
      source: 'MANUAL',
    });
  });

  it('a nudged stored AUTO hold sends EDITED and no origin, so the server keeps its own', () => {
    const wall: SeedableWall = {
      ...EMPTY_WALL,
      holds: [{ id: 8, cx: 100, cy: 200, r: 20, source: 'AUTO', confidence: CONFIDENT }],
    };
    const state = run(seeded([], wall), { type: 'MOVE_HOLD', id: 8, cx: 140, cy: 210 });
    expect(buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY).upsert).toEqual([
      { id: 8, cx: 140, cy: 210, r: 20, outline: null, source: 'AUTO', confidence: CONFIDENT, autoReview: 'EDITED' },
    ]);
  });
});

describe('raiseAutoReview', () => {
  const auto: SprayEditorHold = {
    id: -1,
    cx: 0,
    cy: 0,
    r: 1,
    outline: null,
    source: 'AUTO',
    confidence: CONFIDENT,
    review: 'accepted',
    dirty: true,
  };

  it('only ever moves up ACCEPTED < CONFIRMED < EDITED', () => {
    expect(raiseAutoReview(auto, 'ACCEPTED').autoReview).toBe('ACCEPTED');
    expect(raiseAutoReview({ ...auto, autoReview: 'ACCEPTED' }, 'CONFIRMED').autoReview).toBe('CONFIRMED');
    expect(raiseAutoReview({ ...auto, autoReview: 'CONFIRMED' }, 'ACCEPTED').autoReview).toBe('CONFIRMED');
    expect(raiseAutoReview({ ...auto, autoReview: 'EDITED' }, 'CONFIRMED').autoReview).toBe('EDITED');
  });

  it('hands back the same object when nothing changes, and ignores MANUAL holds', () => {
    const edited = { ...auto, autoReview: 'EDITED' as const };
    expect(raiseAutoReview(edited, 'ACCEPTED')).toBe(edited);
    const manual = { ...auto, source: 'MANUAL' as const };
    expect(raiseAutoReview(manual, 'EDITED')).toBe(manual);
  });
});
