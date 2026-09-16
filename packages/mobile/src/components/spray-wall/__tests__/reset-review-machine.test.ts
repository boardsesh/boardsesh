import { describe, expect, it } from 'vitest';
import {
  buildResetCommitDecisions,
  buildResetDetections,
  buildResetRingTargets,
  canPairMove,
  climbsAffectedIsStale,
  detectionIsReviewable,
  detectionPassesFilter,
  emptyResetReviewState,
  holdPassesFilter,
  holdRingRole,
  initialResetReviewState,
  resetCompareView,
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

  // The verdict on a matched detection is bookkeeping, not a proposal: detections
  // 0 and 1 ARE holds 11 and 12, seen again in the new photograph. Nothing in the
  // review may draw them, target them or toggle them, or a wall where nothing
  // changed shows a grey ring on top of every green one.
  it('leaves a detection that IS an existing hold out of the review', () => {
    const state = seeded();
    expect(state.matchedDetectionIndices).toEqual(new Set([0, 1]));
    expect(detectionIsReviewable(state, 0)).toBe(false);
    expect(detectionIsReviewable(state, 1)).toBe(false);
    expect(detectionIsReviewable(state, 2)).toBe(true);
  });

  it('never draws a matched detection, at any filter', () => {
    const state = seeded();
    expect(detectionPassesFilter(state, 0)).toBe(false);
    expect(detectionPassesFilter(run(state, { type: 'SET_FILTER', filter: 'new' }), 0)).toBe(false);
    expect(detectionPassesFilter(state, 2)).toBe(true);
  });

  it('refuses to toggle a matched detection — it is the hold, not a hold to add', () => {
    const state = seeded();
    expect(run(state, { type: 'TOGGLE_DETECTION', index: 0 })).toBe(state);
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

  it('toggles a reviewable detection between added and rejected', () => {
    // Index 3 is a detection the matcher tied to nothing and did not propose —
    // the only kind with a verdict to give. Indices 0 and 1 ARE holds 11 and 12
    // (see the matched-detection tests above) and index 2 is the proposed
    // addition.
    const start = initialResetReviewState(PROPOSAL, ALIVE, 4);
    const once = run(start, { type: 'TOGGLE_DETECTION', index: 3 });
    expect(once.detectionVerdicts[3]).toBe('added');
    expect(run(once, { type: 'TOGGLE_DETECTION', index: 3 }).detectionVerdicts[3]).toBe('rejected');
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

  // The two refines `CommitSprayWallVersionInputSchema` applies to `added`. Both
  // reject the WHOLE commit, so the payload has to satisfy them by construction —
  // a reset that fails validation after the owner has reviewed a hundred rings is
  // not a thing to debug on a phone in a garage.
  describe('satisfies the server refines on `added`', () => {
    /** Two detections that round to one canonical centre and radius. */
    const COLLIDING: ResetDetection[] = [
      {
        photo: { cx: 0, cy: 0, r: 5, outline: null },
        canonical: { cx: 0, cy: 0, r: 5, outline: null },
        confidence: 0.8,
      },
      {
        photo: { cx: 10, cy: 10, r: 5, outline: null },
        canonical: { cx: 10, cy: 10, r: 5, outline: null },
        confidence: 0.8,
      },
      {
        photo: { cx: 20, cy: 20, r: 5, outline: null },
        canonical: { cx: 40, cy: 40, r: 7, outline: null },
        confidence: 0.8,
      },
      {
        photo: { cx: 21, cy: 21, r: 5, outline: null },
        canonical: { cx: 40, cy: 40, r: 7, outline: null },
        confidence: 0.7,
      },
    ];

    /** Both detections 2 and 3 accepted — they sit at one canonical point. */
    const withBothAccepted = () =>
      run(initialResetReviewState(PROPOSAL, ALIVE, 4), { type: 'TOGGLE_DETECTION', index: 3 });

    it('never sends two additions at the same centre and radius', () => {
      const decisions = buildResetCommitDecisions(withBothAccepted(), COLLIDING);
      const positions = decisions.added.map(({ detection }) => `${detection.cx},${detection.cy},${detection.r}`);

      expect(new Set(positions).size).toBe(positions.length);
      // One hold at that point, not two: rounding made them the same hold.
      expect(positions.filter((position) => position === '40,40,7')).toHaveLength(1);
    });

    it("carries a collapsed duplicate's pairing onto the survivor", () => {
      // The survivor (index 2) has no predecessor; the duplicate (index 3) does,
      // and that pairing still describes this position.
      const paired = run(withBothAccepted(), { type: 'PAIR_MOVE', index: 3, holdId: 13 });
      const decisions = buildResetCommitDecisions(paired, COLLIDING);

      const atPoint = decisions.added.filter(({ detection }) => detection.cx === 40 && detection.cy === 40);
      expect(atPoint).toHaveLength(1);
      expect(atPoint[0].movedFromHoldId).toBe(13);
    });

    it('never sends two additions naming the same predecessor', () => {
      // `canPairMove` refuses the second claim, so the payload cannot carry it —
      // one predecessor has one successor, and `remixClimb` walks that column the
      // other way.
      const paired = run(
        withBothAccepted(),
        { type: 'PAIR_MOVE', index: 2, holdId: 13 },
        { type: 'PAIR_MOVE', index: 3, holdId: 13 },
      );
      const predecessors = buildResetCommitDecisions(paired, COLLIDING)
        .added.map(({ movedFromHoldId }) => movedFromHoldId)
        .filter((holdId): holdId is number => holdId != null);

      expect(new Set(predecessors).size).toBe(predecessors.length);
    });
  });

  it('is stable: the same review sends the same bytes twice', () => {
    const state = seeded();
    expect(buildResetCommitDecisions(state, detections(3))).toEqual(buildResetCommitDecisions(state, detections(3)));
  });
});

describe('resetCompareView', () => {
  const base = { draftLoading: false, proposalPending: false, candidateCount: 12, ready: true };

  it('shows the spinner while the wall is loading, even with nothing detected yet', () => {
    // THE regression. `detections` is empty until the draft's homography lands,
    // so an empty-state test that ran first told every climber their phone had
    // found no holds, seconds before showing them a hundred rings.
    expect(resetCompareView({ ...base, draftLoading: true, candidateCount: 0, ready: false })).toBe('loading');
  });

  it('says nothing was found only when the DETECTOR found nothing', () => {
    expect(resetCompareView({ ...base, candidateCount: 0 })).toBe('no-detections');
  });

  it('shows the spinner while the proposal is in flight', () => {
    expect(resetCompareView({ ...base, proposalPending: true })).toBe('loading');
  });

  it('falls back to unavailable when the wall resolved but cannot be drawn', () => {
    expect(resetCompareView({ ...base, ready: false })).toBe('unavailable');
  });

  it('is ready when the wall, the photo and the proposal have all landed', () => {
    expect(resetCompareView(base)).toBe('ready');
  });
});

describe('buildResetRingTargets', () => {
  const HOLDS = [
    { id: 11, cx: 10, cy: 10, r: 5 },
    { id: 12, cx: 20, cy: 20, r: 5 },
    { id: 13, cx: 30, cy: 30, r: 5 },
  ];

  it('offers every ring at the All filter, minus the ones that are existing holds', () => {
    const ids = buildResetRingTargets(HOLDS, detections(3), seeded()).map((target) => target.id);
    // Holds 11/12/13, plus detection 2 as `-(2 + 1)`. Detections 0 and 1 ARE
    // holds 11 and 12, so they are not separately tappable.
    expect(ids).toEqual([11, 12, 13, -3]);
  });

  it('offers nothing the filter has hidden', () => {
    // THE regression: an unfiltered target under "Gone" made a tap on bare
    // photograph select a kept hold that was not on screen.
    const removedOnly = run(seeded(), { type: 'SET_FILTER', filter: 'removed' });
    expect(buildResetRingTargets(HOLDS, detections(3), removedOnly).map((target) => target.id)).toEqual([13]);

    const newOnly = run(seeded(), { type: 'SET_FILTER', filter: 'new' });
    expect(buildResetRingTargets(HOLDS, detections(3), newOnly).map((target) => target.id)).toEqual([-3]);
  });

  it('follows a hold across a verdict change', () => {
    const putBack = run(seeded(), { type: 'TOGGLE_HOLD', holdId: 13 }, { type: 'SET_FILTER', filter: 'removed' });
    expect(buildResetRingTargets(HOLDS, detections(3), putBack)).toEqual([]);
  });
});
