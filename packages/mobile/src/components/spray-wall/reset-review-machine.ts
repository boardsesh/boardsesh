// Reviewing a proposed reset, as one pure reducer (epic #5346, SW-13).
//
// `proposeSprayWallReset` is a heuristic reading two sets of circles, and the
// epic's rule is that the review has to be HONEST about that: every ring the
// matcher drew a conclusion about is toggleable, and the owner's verdict is what
// commits. So this module holds a verdict per hold and a verdict per detection,
// starts them from the proposal, and lets every one of them be changed.
//
// The one rule it enforces rather than merely records is PAIRING. A hold that
// moved is stored as one removal plus one addition — a climb set on a hold that
// is now 40 cm to the left is not that climb any more — and `movedFromHoldId` is
// the only record of which of today's holds replaced one of yesterday's. The
// server refuses a `movedFromHoldId` that is not in the SAME commit's `removed`
// list, and it is right to: a predecessor still on the wall would leave two holds
// claiming one position, and a predecessor an earlier reset already took off is
// history whose successor was decided then or never. Rather than send that and
// be refused, the pairing is unrepresentable here.
//
// No React, no GraphQL client, no board. Everything the compare screen decides
// is a function of this state, so "what would Confirm send?" is a question a test
// can ask.

import { mapPhotoHoldToCanonical } from '../../lib/spray/spray-hold-canonical';
import type { SprayHoldCandidate } from '../outline-editor/spray-hold-editor-types';

/**
 * One hold found in the new photo, in BOTH frames.
 *
 * The photo copy is what the compare screen draws — the board under it is the
 * new photograph, untouched, because no image is ever warped. The canonical copy
 * is what goes on the wire, because a hold is stored once in the frame version 1
 * defined so that every later photograph agrees about where it is.
 *
 * Both are carried on one object on purpose: the proposal's `added` and
 * `kept.detectionIndex` are INDICES into the array that was sent, so the drawn
 * ring and the sent detection have to be the same element or the review would
 * colour the wrong circle.
 */
export type ResetDetection = {
  photo: { cx: number; cy: number; r: number; outline?: readonly number[] | null };
  canonical: { cx: number; cy: number; r: number; outline: number[] | null };
  confidence: number;
};

/**
 * Detector candidates → the detections the proposal is computed over.
 *
 * Candidates whose canonical map is not usable are DROPPED here, before the
 * array is indexed. Dropping them later — or sending them and letting the server
 * refuse — would shift every index past the bad one, so the proposal would
 * describe holds the screen is not drawing.
 *
 * `homography` is the DRAFT version's own photo→canonical matrix. On a reset it
 * is never the identity: the flow refuses to leave the anchors step without four
 * corners (`reset-wall-machine.ts`), and the server refuses an anchor-less draft.
 */
export function buildResetDetections(
  candidates: readonly SprayHoldCandidate[],
  homography: readonly number[],
): ResetDetection[] {
  const detections: ResetDetection[] = [];
  for (const candidate of candidates) {
    const canonical = mapPhotoHoldToCanonical(homography, candidate);
    if (!canonical) continue;
    detections.push({
      photo: { cx: candidate.cx, cy: candidate.cy, r: candidate.r, outline: candidate.outline ?? null },
      // `outline` is optional on the canonical hold and never optional on the
      // wire: `SprayWallDetectionInput.outline` is "a ring or explicitly none",
      // and an absent key would read as a hold whose silhouette was not traced
      // rather than one that could not be.
      canonical: {
        cx: canonical.cx,
        cy: canonical.cy,
        r: canonical.r,
        outline: canonical.outline ? [...canonical.outline] : null,
      },
      confidence: candidate.confidence,
    });
  }
  return detections;
}

/** The parts of `SprayWallResetProposal` the review reads. */
export type ResetProposal = {
  kept: readonly { holdId: number; detectionIndex: number; confidence: number }[];
  removed: readonly number[];
  added: readonly number[];
  lowConfidence: readonly number[];
  climbsAffected: number;
  movesSuggested: readonly { movedFromHoldId: number; detectionIndex: number; distance: number }[];
  aspectMismatch: boolean;
};

/** What the owner has decided about a hold that is on the wall today. */
export type HoldVerdict = 'kept' | 'removed';
/** What the owner has decided about a hold found in the new photo. */
export type DetectionVerdict = 'added' | 'rejected';

/** Which rings the compare screen is showing. `all` is where it opens. */
export type ResetRingFilter = 'all' | 'kept' | 'removed' | 'new' | 'lowConfidence';

export const RESET_RING_FILTERS: readonly ResetRingFilter[] = ['all', 'kept', 'removed', 'new', 'lowConfidence'];

export type ResetReviewState = {
  /** Every hold alive on the wall today, by id. */
  holdVerdicts: Readonly<Record<number, HoldVerdict>>;
  /** One verdict per detection, indexed exactly as the detections array. */
  detectionVerdicts: readonly DetectionVerdict[];
  /** Detection index → the removed hold it replaces. The `movedFromHoldId` pairing. */
  moves: Readonly<Record<number, number>>;
  /** Kept holds the matcher was unsure about — a second detection was nearly as good. */
  lowConfidenceHoldIds: readonly number[];
  /** Kept hold id → the detection whose silhouette would refresh it. */
  keptDetectionByHoldId: Readonly<Record<number, number>>;
  /**
   * Detection indices the matcher paired with a hold that is already on the wall.
   *
   * These are not proposals about anything — they are today's holds, seen again
   * in the new photograph — so they are not drawn, not tappable and not
   * toggleable. Drawing them would put a second ring on top of every kept hold
   * (a hundred grey rings on a hundred-hold wall where nothing changed), and
   * accepting one would bolt a brand new hold on top of the hold it IS.
   */
  matchedDetectionIndices: ReadonlySet<number>;
  /** What the matcher suggested, kept so "use the suggestion" can be offered per ring. */
  suggestedMoveByDetection: Readonly<Record<number, number>>;
  /** The proposal's own removal set, for {@link climbsAffectedIsStale}. */
  proposedRemovedIds: readonly number[];
  climbsAffected: number;
  aspectMismatch: boolean;
  filter: ResetRingFilter;
  /**
   * Whether a proposal has landed.
   *
   * A flag rather than a nullable state, so the screen renders one shape and the
   * reducer never has to answer questions about a wall it knows nothing about.
   */
  seeded: boolean;
};

export type ResetReviewAction =
  /**
   * The proposal landed. Replaces everything and throws away any review that was
   * in flight — which only happens when the DRAFT changes, and a review of one
   * photograph means nothing about another.
   */
  | { type: 'SEED'; proposal: ResetProposal; aliveHoldIds: readonly number[]; detectionCount: number }
  | { type: 'TOGGLE_HOLD'; holdId: number }
  | { type: 'TOGGLE_DETECTION'; index: number }
  | { type: 'PAIR_MOVE'; index: number; holdId: number }
  | { type: 'UNPAIR_MOVE'; index: number }
  /** Take every suggestion the matcher made that is still valid. */
  | { type: 'ACCEPT_SUGGESTED_MOVES' }
  | { type: 'SET_FILTER'; filter: ResetRingFilter };

/**
 * Start the review from the proposal.
 *
 * `aliveHoldIds` is every hold on the wall today — NOT the union of the
 * proposal's `kept` and `removed`. The two are the same set when the matcher is
 * working, and when they are not, a hold the proposal forgot to mention has to
 * default to KEPT: leaving it out would take it silently off the wall, and
 * "nobody said anything about this hold" means it is still screwed to it.
 */
export function initialResetReviewState(
  proposal: ResetProposal,
  aliveHoldIds: readonly number[],
  detectionCount: number,
): ResetReviewState {
  const holdVerdicts: Record<number, HoldVerdict> = {};
  for (const holdId of aliveHoldIds) holdVerdicts[holdId] = 'kept';
  for (const holdId of proposal.removed) holdVerdicts[holdId] = 'removed';

  const added = new Set(proposal.added);
  // Every detection the matcher tied to a hold already on the wall. Those are
  // that hold seen again, so they are neither an addition nor something to
  // reject — they are excluded from the review entirely (see
  // `matchedDetectionIndices`).
  const matchedDetectionIndices = new Set(proposal.kept.map((kept) => kept.detectionIndex));
  const detectionVerdicts: DetectionVerdict[] = [];
  for (let index = 0; index < detectionCount; index += 1) {
    detectionVerdicts.push(added.has(index) ? 'added' : 'rejected');
  }

  const keptDetectionByHoldId: Record<number, number> = {};
  for (const kept of proposal.kept) keptDetectionByHoldId[kept.holdId] = kept.detectionIndex;

  const suggestedMoveByDetection: Record<number, number> = {};
  for (const move of proposal.movesSuggested) suggestedMoveByDetection[move.detectionIndex] = move.movedFromHoldId;

  return {
    holdVerdicts,
    detectionVerdicts,
    // Empty: a suggestion is not a decision. Pairing a move rewrites what remix
    // offers a climber months later, so it is confirmed ring by ring (or in one
    // go through `ACCEPT_SUGGESTED_MOVES`) and never assumed.
    moves: {},
    lowConfidenceHoldIds: [...proposal.lowConfidence],
    keptDetectionByHoldId,
    matchedDetectionIndices,
    suggestedMoveByDetection,
    proposedRemovedIds: [...proposal.removed],
    climbsAffected: proposal.climbsAffected,
    aspectMismatch: proposal.aspectMismatch,
    filter: 'all',
    seeded: true,
  };
}

/** Is this pairing one the server would accept? The rule, in one place. */
export function canPairMove(state: ResetReviewState, index: number, holdId: number): boolean {
  if (state.detectionVerdicts[index] !== 'added') return false;
  // The predecessor has to be coming off the wall in THIS commit.
  if (state.holdVerdicts[holdId] !== 'removed') return false;
  // And no two additions may claim the same predecessor — that would be one hold
  // that moved to two places.
  for (const [pairedIndex, pairedHoldId] of Object.entries(state.moves)) {
    if (pairedHoldId === holdId && Number(pairedIndex) !== index) return false;
  }
  return true;
}

/** Drop every pairing that names one of these holds. */
function withoutMovesNaming(moves: Readonly<Record<number, number>>, holdId: number): Record<number, number> {
  const next: Record<number, number> = {};
  for (const [index, pairedHoldId] of Object.entries(moves)) {
    if (pairedHoldId !== holdId) next[Number(index)] = pairedHoldId;
  }
  return next;
}

/** The zero value: no wall, no proposal, nothing to review yet. */
export function emptyResetReviewState(): ResetReviewState {
  return {
    holdVerdicts: {},
    detectionVerdicts: [],
    moves: {},
    lowConfidenceHoldIds: [],
    keptDetectionByHoldId: {},
    matchedDetectionIndices: new Set<number>(),
    suggestedMoveByDetection: {},
    proposedRemovedIds: [],
    climbsAffected: 0,
    aspectMismatch: false,
    filter: 'all',
    seeded: false,
  };
}

export function resetReviewReducer(state: ResetReviewState, action: ResetReviewAction): ResetReviewState {
  switch (action.type) {
    case 'SEED':
      return initialResetReviewState(action.proposal, action.aliveHoldIds, action.detectionCount);

    case 'TOGGLE_HOLD': {
      const current = state.holdVerdicts[action.holdId];
      if (!current) return state;
      const next: HoldVerdict = current === 'kept' ? 'removed' : 'kept';
      return {
        ...state,
        holdVerdicts: { ...state.holdVerdicts, [action.holdId]: next },
        // A hold put back on the wall cannot be anybody's predecessor: it did not
        // move, it never left. Leaving the pairing would send the server a
        // `movedFromHoldId` naming a hold that is not in `removed`, which it
        // refuses — and refuses the whole commit with it.
        moves: next === 'kept' ? withoutMovesNaming(state.moves, action.holdId) : state.moves,
      };
    }

    case 'TOGGLE_DETECTION': {
      const current = state.detectionVerdicts[action.index];
      if (!current) return state;
      // A detection that IS a hold on the wall has no verdict to give. Accepting
      // it would add a second hold at the same place; rejecting it would say
      // nothing, since it was never going to be written either way.
      if (state.matchedDetectionIndices.has(action.index)) return state;
      const next: DetectionVerdict = current === 'added' ? 'rejected' : 'added';
      const verdicts = [...state.detectionVerdicts];
      verdicts[action.index] = next;
      const moves = { ...state.moves };
      // A rejected detection is not going on the wall, so it replaces nothing.
      if (next === 'rejected') delete moves[action.index];
      return { ...state, detectionVerdicts: verdicts, moves };
    }

    case 'PAIR_MOVE': {
      if (!canPairMove(state, action.index, action.holdId)) return state;
      return { ...state, moves: { ...state.moves, [action.index]: action.holdId } };
    }

    case 'UNPAIR_MOVE': {
      if (state.moves[action.index] == null) return state;
      const moves = { ...state.moves };
      delete moves[action.index];
      return { ...state, moves };
    }

    case 'ACCEPT_SUGGESTED_MOVES': {
      const moves = { ...state.moves };
      let changed = false;
      for (const [rawIndex, holdId] of Object.entries(state.suggestedMoveByDetection)) {
        const index = Number(rawIndex);
        if (moves[index] != null) continue;
        // Re-checked against the CURRENT state, not the proposal's: the owner may
        // have put the predecessor back on the wall since, and a suggestion is
        // only a suggestion.
        if (!canPairMove({ ...state, moves }, index, holdId)) continue;
        moves[index] = holdId;
        changed = true;
      }
      return changed ? { ...state, moves } : state;
    }

    case 'SET_FILTER':
      return state.filter === action.filter ? state : { ...state, filter: action.filter };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors. Pure, and every one of them is called from a `useMemo` in the
// screen rather than read out of a closure.
// ---------------------------------------------------------------------------

export type ResetReviewCounts = {
  kept: number;
  removed: number;
  added: number;
  /** Kept holds the matcher flagged as worth a look, still kept. */
  lowConfidence: number;
  /** Confirmed "same hold, moved here" pairings. */
  moves: number;
};

export function resetReviewCounts(state: ResetReviewState): ResetReviewCounts {
  let kept = 0;
  let removed = 0;
  for (const verdict of Object.values(state.holdVerdicts)) {
    if (verdict === 'kept') kept += 1;
    else removed += 1;
  }
  let added = 0;
  for (const verdict of state.detectionVerdicts) {
    if (verdict === 'added') added += 1;
  }
  const lowConfidence = state.lowConfidenceHoldIds.filter((holdId) => state.holdVerdicts[holdId] === 'kept').length;
  return { kept, removed, added, lowConfidence, moves: Object.keys(state.moves).length };
}

/**
 * Has the owner changed the removal set the "N climbs lose holds" number was
 * computed for?
 *
 * The count comes from the server, which read `board_climb_holds` for the
 * proposal's own removals. Nothing on the phone can recompute it — the climbs'
 * holds are not here — so when the set moves, the honest thing is to stop
 * showing a number that is about a different set, not to show it with a caveat.
 */
export function climbsAffectedIsStale(state: ResetReviewState): boolean {
  const removedNow = new Set<number>();
  for (const [holdId, verdict] of Object.entries(state.holdVerdicts)) {
    if (verdict === 'removed') removedNow.add(Number(holdId));
  }
  if (removedNow.size !== state.proposedRemovedIds.length) return true;
  return state.proposedRemovedIds.some((holdId) => !removedNow.has(holdId));
}

/** How one of today's holds is drawn. */
export type HoldRingRole = 'kept' | 'removed' | 'lowConfidence';

export function holdRingRole(state: ResetReviewState, holdId: number): HoldRingRole | null {
  const verdict = state.holdVerdicts[holdId];
  if (!verdict) return null;
  if (verdict === 'removed') return 'removed';
  return state.lowConfidenceHoldIds.includes(holdId) ? 'lowConfidence' : 'kept';
}

/** Whether a ring is on screen at the current filter. */
export function holdPassesFilter(state: ResetReviewState, holdId: number): boolean {
  if (state.filter === 'all') return true;
  const role = holdRingRole(state, holdId);
  if (state.filter === 'new') return false;
  return role === state.filter;
}

/**
 * Is this detection part of the review at all?
 *
 * A detection the matcher tied to a hold that is already on the wall is that
 * hold, so the kept ring is the only thing that should be drawn for it. THE
 * gate — every consumer (the SVG buckets, the tap targets, the filter) reads
 * this rather than re-deciding it.
 */
export function detectionIsReviewable(state: ResetReviewState, index: number): boolean {
  return !state.matchedDetectionIndices.has(index);
}

export function detectionPassesFilter(state: ResetReviewState, index: number): boolean {
  if (!detectionIsReviewable(state, index)) return false;
  if (state.filter === 'all') return true;
  if (state.filter !== 'new') return false;
  return state.detectionVerdicts[index] === 'added';
}

// ---------------------------------------------------------------------------
// The commit payload.
// ---------------------------------------------------------------------------

/** One detection as `SprayWallDetectionInput` wants it: canonical pixels. */
export type ResetDetectionWire = {
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
  source: 'AUTO';
  confidence: number;
};

/**
 * Mutable arrays, deliberately: this is the payload `CommitSprayWallVersionInput`
 * takes, and codegen types its list fields as mutable. Nothing reads the result
 * twice, so there is nothing for `readonly` to protect.
 */
export type ResetCommitDecisions = {
  kept: { holdId: number; detection: ResetDetectionWire }[];
  removed: number[];
  added: { detection: ResetDetectionWire; movedFromHoldId?: number }[];
};

function toWire(detection: ResetDetection): ResetDetectionWire {
  return {
    cx: detection.canonical.cx,
    cy: detection.canonical.cy,
    r: detection.canonical.r,
    outline: detection.canonical.outline,
    source: 'AUTO',
    confidence: detection.confidence,
  };
}

/**
 * What Confirm would send.
 *
 * Two shapes are deliberate:
 *
 *  - a kept hold is listed ONLY when there is a detection to refresh its
 *    silhouette from. An alive hold the decisions never mention simply stays on
 *    the wall (`docs/spray-walls.md`, "What the commit writes"), so listing the
 *    rest would be a longer payload saying the same thing. Note the server takes
 *    only the OUTLINE from the detection — `cx`/`cy`/`r` stay exactly as
 *    published, because every climb on the wall renders from those numbers.
 *  - `movedFromHoldId` rides the addition, and by construction it names a hold
 *    that is in `removed` — `canPairMove` is the only way a pairing gets into the
 *    state, and putting a hold back on the wall drops the pairings naming it.
 */
export function buildResetCommitDecisions(
  state: ResetReviewState,
  detections: readonly ResetDetection[],
): ResetCommitDecisions {
  const removed: number[] = [];
  const kept: { holdId: number; detection: ResetDetectionWire }[] = [];

  for (const [rawHoldId, verdict] of Object.entries(state.holdVerdicts)) {
    const holdId = Number(rawHoldId);
    if (verdict === 'removed') {
      removed.push(holdId);
      continue;
    }
    const detectionIndex = state.keptDetectionByHoldId[holdId];
    const detection = detectionIndex == null ? undefined : detections[detectionIndex];
    if (detection) kept.push({ holdId, detection: toWire(detection) });
  }

  /**
   * Additions, with duplicates at one position collapsed.
   *
   * Two accepted detections can round to the SAME canonical centre and radius —
   * `mapPhotoHoldToCanonical` rounds to integers because the columns are
   * integers, so two blobs a pixel apart in a 2048 px photo become one hold in
   * the frame. Sending both is refused (`CommitSprayWallVersionInputSchema`:
   * "Two new holds sit at the same place"), and the server is right to: they
   * would land as two catalogue ids at one point, with no DB conflict to notice,
   * leaving the wall carrying an invisible duplicate that every read returns and
   * the editor cannot tell apart.
   *
   * The FIRST in detection order wins, and a pairing from a collapsed duplicate
   * is carried onto it only when the survivor has none — a predecessor may name
   * one successor and no more (the other refine on the same input), so of two
   * competing pairings the survivor's own is kept and the loser's predecessor
   * simply ends up with no recorded successor. That costs one remix suggestion;
   * sending both costs the whole commit.
   */
  const added: { detection: ResetDetectionWire; movedFromHoldId?: number }[] = [];
  const addedByPosition = new Map<string, number>();
  state.detectionVerdicts.forEach((verdict, index) => {
    if (verdict !== 'added') return;
    const detection = detections[index];
    if (!detection) return;
    const wire = toWire(detection);
    const position = `${wire.cx},${wire.cy},${wire.r}`;
    const movedFromHoldId = state.moves[index];

    const existing = addedByPosition.get(position);
    if (existing != null) {
      if (movedFromHoldId != null && added[existing].movedFromHoldId == null) {
        added[existing] = { ...added[existing], movedFromHoldId };
      }
      return;
    }

    addedByPosition.set(position, added.length);
    added.push(movedFromHoldId == null ? { detection: wire } : { detection: wire, movedFromHoldId });
  });

  // Sorted so the payload is stable across renders — a retry after a network
  // failure sends the same bytes, and a test can assert on them.
  removed.sort((left, right) => left - right);
  kept.sort((left, right) => left.holdId - right.holdId);

  return { kept, removed, added };
}

// ---------------------------------------------------------------------------
// What the compare screen shows, and what it lets a finger reach. Both are pure
// so the two mistakes they exist to prevent — telling a climber their phone
// found nothing while the wall is still loading, and putting a tap target on a
// ring the filter has hidden — are unit tests rather than something you can only
// see by standing in front of a wall.
// ---------------------------------------------------------------------------

export type ResetCompareView = 'loading' | 'no-detections' | 'unavailable' | 'ready';

/**
 * Which of the compare screen's four states is showing.
 *
 * Order matters and is the whole reason this is a function. `detections` is
 * empty until the draft's homography arrives, so "this phone found no holds" and
 * "the wall has not loaded yet" look identical from the inside — and answering
 * the first while the second is true told every climber their reset could not be
 * reviewed, seconds before showing them a hundred rings. Loading wins, and
 * `candidateCount` (what the DETECTOR found, which is known before any of this
 * loads) is what decides the empty state rather than the mapped detections.
 */
export function resetCompareView(input: {
  draftLoading: boolean;
  proposalPending: boolean;
  /** Detector output, before the canonical mapping. Known from the moment the flow hands over. */
  candidateCount: number;
  ready: boolean;
}): ResetCompareView {
  if (input.draftLoading) return 'loading';
  if (input.candidateCount === 0) return 'no-detections';
  if (input.proposalPending) return 'loading';
  return input.ready ? 'ready' : 'unavailable';
}

/** One tappable ring: a positive hold id, or `-(detectionIndex + 1)`. */
export type ResetRingTarget = { id: number; cx: number; cy: number; r: number };

/**
 * Every ring a finger may reach, at the current filter.
 *
 * The SAME predicates the SVG layer draws through, because a target the filter
 * has hidden is a tap on bare photograph that opens the panel for a ring nobody
 * can see: under "Gone", an empty patch of wall would select a kept hold that is
 * not on screen.
 */
export function buildResetRingTargets(
  holds: readonly { id: number; cx: number; cy: number; r: number }[],
  detections: readonly ResetDetection[],
  state: ResetReviewState,
): ResetRingTarget[] {
  const targets: ResetRingTarget[] = [];
  for (const hold of holds) {
    if (!holdPassesFilter(state, hold.id)) continue;
    targets.push({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r });
  }
  detections.forEach((detection, index) => {
    if (!detectionPassesFilter(state, index)) return;
    targets.push({ id: -(index + 1), cx: detection.photo.cx, cy: detection.photo.cy, r: detection.photo.r });
  });
  return targets;
}
