import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import { MAX_RING_NUMBERS } from '@boardsesh/board-art-geometry/ring';
import {
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorHold,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { buildSprayHoldWritePlan, planHasWork } from '../spray-hold-writes';

function storedHold(id: number, overrides: Partial<SprayEditorHold> = {}): SprayEditorHold {
  return {
    id,
    cx: 100,
    cy: 200,
    r: 20,
    outline: null,
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
    ...overrides,
  };
}

function run(holds: SprayEditorHold[], ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds }));
}

/** Photo px → canonical px: half scale, shifted right 10. Row-major. */
const HALF_SCALE: number[] = [0.5, 0, 10, 0, 0.5, 0, 0, 0, 1];

describe('buildSprayHoldWritePlan', () => {
  it('sends nothing for a wall nobody touched', () => {
    const plan = buildSprayHoldWritePlan(run([storedHold(1), storedHold(2)]), IDENTITY_HOMOGRAPHY);
    expect(plan.upsert).toEqual([]);
    expect(plan.removeIds).toEqual([]);
    expect(planHasWork(plan)).toBe(false);
  });

  it('sends a stored hold BY ID and a new one with no id at all', () => {
    const state = run(
      [storedHold(7)],
      { type: 'MOVE_HOLD', id: 7, cx: 150, cy: 250 },
      { type: 'ADD_HOLD', geometry: { cx: 300, cy: 400, r: 25, outline: null } },
    );
    const plan = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY);
    expect(plan.upsert).toEqual([
      { cx: 300, cy: 400, r: 25, outline: null, source: 'MANUAL' },
      { id: 7, cx: 150, cy: 250, r: 20, outline: null, source: 'MANUAL' },
    ]);
  });

  it('never sends a candidate nobody ruled on', () => {
    const state = run([storedHold(-1, { source: 'AUTO', confidence: 0.95, review: 'pending' })]);
    expect(buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY).upsert).toEqual([]);
  });

  it('sends an accepted candidate as AUTO, with its confidence intact', () => {
    const state = run([storedHold(-1, { source: 'AUTO', confidence: 0.82, review: 'pending' })], {
      type: 'ACCEPT',
      ids: [-1],
    });
    expect(buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY).upsert).toEqual([
      { cx: 100, cy: 200, r: 20, outline: null, source: 'AUTO', confidence: 0.82 },
    ]);
  });

  it('never claims a confidence for a hand-drawn hold', () => {
    const state = run([], { type: 'ADD_HOLD', geometry: { cx: 1, cy: 2, r: 3, outline: null } });
    const [written] = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY).upsert;
    expect(written).not.toHaveProperty('confidence');
  });

  it('maps every coordinate through the homography and rounds to whole canonical pixels', () => {
    const state = run([storedHold(3, { cx: 101, cy: 203, r: 21 })], {
      type: 'MOVE_HOLD',
      id: 3,
      cx: 101,
      cy: 205,
    });
    const [written] = buildSprayHoldWritePlan(state, HALF_SCALE).upsert;
    // (101, 205) at half scale, shifted right 10 → (60.5, 102.5) → (61, 103); r 21 → 10.5 → 11.
    expect(written).toMatchObject({ id: 3, cx: 61, cy: 103, r: 11 });
    expect(Number.isInteger(written.cx)).toBe(true);
    expect(Number.isInteger(written.r)).toBe(true);
  });

  it('carries removals separately, so they can be stamped before the upsert lands', () => {
    const state = run([storedHold(4), storedHold(5)], { type: 'DELETE', ids: [4] });
    const plan = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY);
    expect(plan.removeIds).toEqual([4]);
    expect(plan.upsert).toEqual([]);
    expect(planHasWork(plan)).toBe(true);
  });

  it('drops an outline the backend would refuse and saves the hold as a circle', () => {
    // A ring one point past the cap. The editor's own chain never produces one,
    // but a homography that stretches an already-long ring can, and losing the
    // hold over its silhouette would be the worse answer.
    const tooLong: number[] = [];
    for (let index = 0; index < MAX_RING_NUMBERS / 2 + 1; index += 1) {
      const angle = (index / (MAX_RING_NUMBERS / 2 + 1)) * Math.PI * 2;
      tooLong.push(Math.cos(angle), Math.sin(angle));
    }
    const state = run([], { type: 'ADD_HOLD', geometry: { cx: 100, cy: 100, r: 20, outline: tooLong } });
    const plan = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY);
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0].outline).toBeNull();
    expect(plan.outlinesDropped).toBe(1);
  });

  it('keeps an outline the backend would accept', () => {
    const ring = [1, 0, 0, 1, -1, 0, 0, -1];
    const state = run([], { type: 'ADD_HOLD', geometry: { cx: 100, cy: 100, r: 20, outline: ring } });
    const plan = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY);
    expect(plan.upsert[0].outline).toEqual(ring);
    expect(plan.outlinesDropped).toBe(0);
  });

  it('drops a hold the homography sends nowhere instead of writing it somewhere wrong', () => {
    // A degenerate matrix: the projective denominator is zero everywhere.
    const singular = [1, 0, 0, 0, 1, 0, 0, 0, 0];
    const state = run([], { type: 'ADD_HOLD', geometry: { cx: 100, cy: 100, r: 20, outline: null } });
    const plan = buildSprayHoldWritePlan(state, singular);
    expect(plan.upsert).toEqual([]);
    expect(plan.unmappableIds).toEqual([-1]);
    expect(planHasWork(plan)).toBe(false);
  });

  it('flags a batch past the per-wall cap rather than letting the server refuse it', () => {
    const holds = Array.from({ length: 1501 }, (_, index) => storedHold(index + 1, { dirty: true }));
    const plan = buildSprayHoldWritePlan(run(holds), IDENTITY_HOMOGRAPHY);
    expect(plan.overCap).toBe(true);
  });

  it('a merge sends the survivor and removes the victim in one plan', () => {
    const state = run([storedHold(8, { cx: 100, cy: 100 }), storedHold(9, { cx: 140, cy: 100 })], {
      type: 'MERGE',
      ids: [8, 9],
    });
    const plan = buildSprayHoldWritePlan(state, IDENTITY_HOMOGRAPHY);
    expect(plan.removeIds).toEqual([9]);
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0].id).toBe(8);
  });
});
