import { describe, expect, it } from 'vitest';
import {
  buildResetCommitDecisions,
  buildResetDetections,
  canPairMove,
  climbsAffectedIsStale,
  detectionPassesFilter,
  emptyResetReviewState,
  holdPassesFilter,
  holdRingRole,
  initialResetReviewState,
  resetReviewCounts,
  resetReviewReducer,
  type ResetDetection,
  type ResetProposal,
  type ResetReviewAction,
  type ResetReviewState,
} from '../reset-review-machine';

/** The identity homography: canonical frame == photo frame. */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const ALIVE = [11, 12, 13];

const PROPOSAL: ResetProposal = {
  kept: [
    { holdId: 11, detectionIndex: 0, confidence: 0.95 },
    { holdId: 12, detectionIndex: 1, confidence: 0.61 },
  ],
  removed: [13],
  added: [2],
  lowConfidence: [12],
  climbsAffected: 4,
  movesSuggested: [{ movedFromHoldId: 13, detectionIndex: 2, distance: 30 }],
  aspectMismatch: false,
};

function detections(count: number): ResetDetection[] {
  return Array.from({ length: count }, (_unused, index) => ({
    photo: { cx: index * 10, cy: index * 10, r: 5, outline: null },
    canonical: { cx: index * 10, cy: index * 10, r: 5, outline: null },
    confidence: 0.8,
  }));
}

function seeded(): ResetReviewState {
  return initialResetReviewState(PROPOSAL, ALIVE, 3);
}

function run(state: ResetReviewState, ...actions: ResetReviewAction[]): ResetReviewState {
  return actions.reduce(resetReviewReducer, state);
}

describe('buildResetDetections', () => {
  it('maps every candidate into both frames and keeps the indices aligned', () => {
    const built = buildResetDetections(
      [
        { cx: 10, cy: 20, r: 4, confidence: 0.9 },
        { cx: 30, cy: 40, r: 6, confidence: 0.4 },
      ],
      IDENTITY,
    );
    expect(built).toHaveLength(2);
    expect(built[0].photo).toMatchObject({ cx: 10, cy: 20, r: 4 });
    expect(built[0].canonical).toMatchObject({ cx: 10, cy: 20, r: 4 });
    expect(built[1].confidence).toBe(0.4);
  });

  it('drops a candidate the homography cannot place, so the array is never sparse', () => {
    const built = buildResetDetections(
      [
        { cx: 10, cy: 20, r: 4, confidence: 0.9 },
        { cx: Number.NaN, cy: 40, r: 6, confidence: 0.4 },
        { cx: 50, cy: 60, r: 3, confidence: 0.7 },
      ],
      IDENTITY,
    );
    expect(built).toHaveLength(2);
    // The survivor that was third is now second: the proposal is expressed in
    // indices into THIS array, so a hole would colour the wrong ring.
    expect(built[1].photo.cx).toBe(50);
  });

  it('writes an explicit null outline rather than leaving the key off the wire', () => {
    const built = buildResetDetections([{ cx: 10, cy: 20, r: 4, confidence: 0.9 }], IDENTITY);
    expect(built[0].canonical.outline).toBeNull();
  });
});

describe('initialResetReviewState', () => {
  it('starts every hold on the wall as kept, then applies the proposal removals', () => {
    const state = seeded();
    expect(state.holdVerdicts).toEqual({ 11: 'kept', 12: 'kept', 13: 'removed' });
    expect(state.seeded).toBe(true);
  });

  it('keeps a hold the proposal never mentions — silence is not a removal', () => {
    const state = initialResetReviewState(PROPOSAL, [...ALIVE, 99], 3);
    expect(state.holdVerdicts[99]).toBe('kept');
  });

  it('proposes only the leftovers as additions', () => {
    expect(seeded().detectionVerdicts).toEqual(['rejected', 'rejected', 'added']);
  });

  it('records the suggested moves without applying any of them', () => {
    const state = seeded();
    expect(state.suggestedMoveByDetection).toEqual({ 2: 13 });
    expect(state.moves).toEqual({});
  });

  it('is not seeded before a proposal lands', () => {
    expect(emptyResetReviewState().seeded).toBe(false);
  });
});

describe('resetReviewReducer — verdicts', () => {
  it('toggles a hold between kept and removed', () => {
    const once = run(seeded(), { type: 'TOGGLE_HOLD', holdId: 11 });
    expect(once.holdVerdicts[11]).toBe('removed');
    expect(run(once, { type: 'TOGGLE_HOLD', holdId: 11 }).holdVerdicts[11]).toBe('kept');
  });

  it('ignores a hold that is not on the wall', () => {
    const state = seeded();
    expect(run(state, { type: 'TOGGLE_HOLD', holdId: 404 })).toBe(state);
  });

  it('toggles a detection between added and rejected', () => {
    const once = run(seeded(), { type: 'TOGGLE_DETECTION', index: 0 });
    expect(once.detectionVerdicts[0]).toBe('added');
    expect(run(once, { type: 'TOGGLE_DETECTION', index: 0 }).detectionVerdicts[0]).toBe('rejected');
  });

  it('counts what the wall would look like', () => {
    expect(resetReviewCounts(seeded())).toEqual({ kept: 2, removed: 1, added: 1, lowConfidence: 1, moves: 0 });
  });

  it('stops counting a low-confidence hold once it has been taken off the wall', () => {
    const state = run(seeded(), { type: 'TOGGLE_HOLD', holdId: 12 });
    expect(resetReviewCounts(state).lowConfidence).toBe(0);
  });
});

describe('resetReviewReducer — pairing a move', () => {
  it('pairs an addition with a hold that is coming off in this same commit', () => {
    const state = run(seeded(), { type: 'PAIR_MOVE', index: 2, holdId: 13 });
    expect(state.moves).toEqual({ 2: 13 });
  });

  it('refuses a predecessor that is staying on the wall', () => {
    // The server refuses it too: a predecessor still on the wall would leave two
    // holds claiming one position, with nothing left to notice the mistake.
    const state = seeded();
    expect(canPairMove(state, 2, 11)).toBe(false);
    expect(run(state, { type: 'PAIR_MOVE', index: 2, holdId: 11 }).moves).toEqual({});
  });

  it('refuses to pair a detection that is not going on the wall', () => {
    const state = seeded();
    expect(canPairMove(state, 0, 13)).toBe(false);
    expect(run(state, { type: 'PAIR_MOVE', index: 0, holdId: 13 }).moves).toEqual({});
  });

  it('refuses a predecessor another addition has already claimed', () => {
    const paired = run(seeded(), { type: 'TOGGLE_DETECTION', index: 0 }, { type: 'PAIR_MOVE', index: 2, holdId: 13 });
    expect(canPairMove(paired, 0, 13)).toBe(false);
    expect(run(paired, { type: 'PAIR_MOVE', index: 0, holdId: 13 }).moves).toEqual({ 2: 13 });
  });

  it('drops the pairing when the predecessor is put back on the wall', () => {
    const state = run(seeded(), { type: 'PAIR_MOVE', index: 2, holdId: 13 }, { type: 'TOGGLE_HOLD', holdId: 13 });
    expect(state.moves).toEqual({});
  });

  it('drops the pairing when the addition is rejected', () => {
    const state = run(seeded(), { type: 'PAIR_MOVE', index: 2, holdId: 13 }, { type: 'TOGGLE_DETECTION', index: 2 });
    expect(state.moves).toEqual({});
  });

  it('unpairs on request', () => {
    const state = run(seeded(), { type: 'PAIR_MOVE', index: 2, holdId: 13 }, { type: 'UNPAIR_MOVE', index: 2 });
    expect(state.moves).toEqual({});
  });

  it('takes every suggestion that is still valid, and no others', () => {
    expect(run(seeded(), { type: 'ACCEPT_SUGGESTED_MOVES' }).moves).toEqual({ 2: 13 });
    // The owner put the predecessor back, so the suggestion is no longer one.
    const putBack = run(seeded(), { type: 'TOGGLE_HOLD', holdId: 13 }, { type: 'ACCEPT_SUGGESTED_MOVES' });
    expect(putBack.moves).toEqual({});
  });
});

describe('resetReviewReducer — the filter', () => {
  it('shows everything at `all`', () => {
    const state = seeded();
    expect(holdPassesFilter(state, 11)).toBe(true);
    expect(detectionPassesFilter(state, 2)).toBe(true);
  });

  it('shows only removals at `removed`', () => {
    const state = run(seeded(), { type: 'SET_FILTER', filter: 'removed' });
    expect(holdPassesFilter(state, 13)).toBe(true);
    expect(holdPassesFilter(state, 11)).toBe(false);
    expect(detectionPassesFilter(state, 2)).toBe(false);
  });

  it('shows only additions at `new`', () => {
    const state = run(seeded(), { type: 'SET_FILTER', filter: 'new' });
    expect(detectionPassesFilter(state, 2)).toBe(true);
    expect(detectionPassesFilter(state, 0)).toBe(false);
    expect(holdPassesFilter(state, 11)).toBe(false);
  });

  it('separates a kept hold the matcher was unsure about from one it was sure about', () => {
    const state = seeded();
    expect(holdRingRole(state, 11)).toBe('kept');
    expect(holdRingRole(state, 12)).toBe('lowConfidence');
    expect(holdRingRole(state, 13)).toBe('removed');
  });
});

describe('climbsAffectedIsStale', () => {
  it('is false while the removal set is the one the server counted', () => {
    expect(climbsAffectedIsStale(seeded())).toBe(false);
  });

  it('is true the moment the owner adds a removal', () => {
    expect(climbsAffectedIsStale(run(seeded(), { type: 'TOGGLE_HOLD', holdId: 11 }))).toBe(true);
  });

  it('is true the moment the owner puts a removal back', () => {
    expect(climbsAffectedIsStale(run(seeded(), { type: 'TOGGLE_HOLD', holdId: 13 }))).toBe(true);
  });
});

describe('buildResetCommitDecisions', () => {
  it('sends the removals, the refreshed silhouettes and the additions', () => {
    const decisions = buildResetCommitDecisions(seeded(), detections(3));
    expect(decisions.removed).toEqual([13]);
    expect(decisions.kept.map((entry) => entry.holdId)).toEqual([11, 12]);
    expect(decisions.added).toHaveLength(1);
    expect(decisions.added[0].detection).toMatchObject({ cx: 20, cy: 20, r: 5, source: 'AUTO' });
    expect(decisions.added[0].movedFromHoldId).toBeUndefined();
  });

  it('leaves a kept hold with no matched detection out — an unmentioned hold simply stays', () => {
    const state = initialResetReviewState(PROPOSAL, [...ALIVE, 99], 3);
    expect(buildResetCommitDecisions(state, detections(3)).kept.map((entry) => entry.holdId)).toEqual([11, 12]);
  });

  it('carries a confirmed pairing as movedFromHoldId, and it is always in `removed`', () => {
    const decisions = buildResetCommitDecisions(
      run(seeded(), { type: 'PAIR_MOVE', index: 2, holdId: 13 }),
      detections(3),
    );
    expect(decisions.added[0].movedFromHoldId).toBe(13);
    expect(decisions.removed).toContain(13);
  });

  it('sends a hold the owner put back as neither removed nor kept — it never changed', () => {
    const decisions = buildResetCommitDecisions(run(seeded(), { type: 'TOGGLE_HOLD', holdId: 13 }), detections(3));
    expect(decisions.removed).toEqual([]);
    expect(decisions.kept.map((entry) => entry.holdId)).toEqual([11, 12]);
  });

  it('is stable: the same review sends the same bytes twice', () => {
    const state = seeded();
    expect(buildResetCommitDecisions(state, detections(3))).toEqual(buildResetCommitDecisions(state, detections(3)));
  });
});
