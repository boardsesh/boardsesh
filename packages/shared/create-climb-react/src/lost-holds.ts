import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { applyHoldState } from './hold-paint';

/**
 * A spray climb that lost holds in a reset (#5493): where each lost hold was,
 * what role it played, and which live holds could stand in for it.
 *
 * Pure and renderer-agnostic. Every coordinate here is in ONE frame chosen by the
 * caller — the mobile editor passes the wall photo's pixels, the same frame its
 * hold targets use — so nothing in this file knows about homographies, zoom or
 * the screen.
 */

/** One hold's circle, plus the hold a reset review said it replaced. */
export type HoldCircle = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /** Set on a live hold that a reset review linked to a hold it replaced. */
  movedFromHoldId?: number | null;
};

/** A lost hold's geometry as it was on the wall, in the caller's frame. */
export type LostHoldGeometry = HoldCircle & {
  /** Flat ring in units of `r`, relative to the centre; absent → draw the circle. */
  outline?: readonly number[] | null;
};

/** Where a hold sits in a climb: which frame, and in what role there. */
export type HoldPlacement = { frameIndex: number; state: HoldState };

/** A lost hold the editor draws as a dashed ring and offers to replace. */
export type LostHoldGhost = LostHoldGeometry & {
  /** Its role in the first frame it appears in — the colour the ring is drawn in. */
  role: HoldState;
  /** The role's colour as the climb stored it. */
  color: string;
  /** Every frame it was in, with its role in each, for a replacement to take over. */
  placements: HoldPlacement[];
};

/** A live hold offered in place of a lost one. */
export type ReplacementCandidate = {
  holdId: number;
  /** Centre-to-centre distance from the lost hold, in the caller's frame. */
  distance: number;
  /** The reset review linked this hold to the lost one (its successor). */
  isSuccessor: boolean;
};

/** Nearby means within this many lost-hold radii, centre to centre. */
export const NEARBY_RADIUS_MULTIPLIER = 8;
/** How many candidates the editor highlights at most. */
export const MAX_REPLACEMENT_CANDIDATES = 5;
/** When nothing is inside the nearby radius, the closest few are offered anyway. */
export const FALLBACK_REPLACEMENT_CANDIDATES = 3;

/**
 * Every frame the hold appears in, with its role there.
 *
 * Frame indices are the source climb's. The editor seeds its own frames from the
 * same string, and the sanitiser that drops lost holds keeps the frame count, so
 * the indices line up on load. `applyHoldPlacements` ignores any that no longer
 * exist (a frame deleted since).
 */
export function lostHoldPlacements(sourceFrames: readonly LitUpHoldsMap[], holdId: number): HoldPlacement[] {
  const placements: HoldPlacement[] = [];
  sourceFrames.forEach((frame, frameIndex) => {
    const hold = frame[holdId];
    if (hold && hold.state !== 'OFF') placements.push({ frameIndex, state: hold.state });
  });
  return placements;
}

/**
 * The hold ids a climb names that the device's wall no longer has.
 *
 * Device-derived on purpose: it works with no signal, and it is exactly the set
 * the editor's sanitiser stripped (`availableHoldIds`), so the number the banner
 * states is the number of holds missing from the editor.
 */
export function findLostHoldIds(sourceFrames: readonly LitUpHoldsMap[], liveHoldIds: ReadonlySet<number>): number[] {
  const lost = new Set<number>();
  for (const frame of sourceFrames) {
    for (const [holdKey, hold] of Object.entries(frame)) {
      const holdId = Number(holdKey);
      if (hold.state !== 'OFF' && !liveHoldIds.has(holdId)) lost.add(holdId);
    }
  }
  return [...lost].sort((left, right) => left - right);
}

/**
 * The ghosts to draw: lost holds this climb used and this device's wall no
 * longer carries.
 *
 * A hold the server reports lost but the device still has is skipped — the
 * editor kept it painted (the device's wall is behind), so a ghost on top of it
 * would contradict the paint. A server hold the climb never used is skipped too.
 */
export function buildLostHoldGhosts({
  sourceFrames,
  lostHolds,
  liveHoldIds,
}: {
  sourceFrames: readonly LitUpHoldsMap[];
  lostHolds: readonly LostHoldGeometry[];
  liveHoldIds: ReadonlySet<number>;
}): LostHoldGhost[] {
  const ghosts: LostHoldGhost[] = [];
  for (const lostHold of lostHolds) {
    if (liveHoldIds.has(lostHold.id)) continue;
    const placements = lostHoldPlacements(sourceFrames, lostHold.id);
    if (placements.length === 0) continue;
    const first = sourceFrames[placements[0].frameIndex][lostHold.id];
    ghosts.push({
      ...lostHold,
      role: placements[0].state,
      color: first.displayColor || first.color,
      placements,
    });
  }
  return ghosts.sort((left, right) => left.id - right.id);
}

function centreDistance(left: { cx: number; cy: number }, right: { cx: number; cy: number }): number {
  return Math.hypot(left.cx - right.cx, left.cy - right.cy);
}

/**
 * Whether a painted hold now sits where the ghost was.
 *
 * Covers the replacement a climber made in an earlier session (a restored
 * autosave carries the paint but not which ghost it answered) and a successor
 * painted by hand: either way something is on that spot, so the ghost has
 * nothing left to say. "On" means centres closer than the larger radius.
 */
export function isGhostCovered(ghost: HoldCircle, paintedHolds: readonly HoldCircle[]): boolean {
  return paintedHolds.some((hold) => centreDistance(ghost, hold) <= Math.max(ghost.r, hold.r));
}

/**
 * The live holds to offer in place of a lost one, best first.
 *
 * Successors lead: a live hold whose `movedFromHoldId` names the lost one (the
 * reset review linked them), or one the server suggested. Then the nearest free
 * holds within `NEARBY_RADIUS_MULTIPLIER` radii. When nothing is that close, the
 * closest `FALLBACK_REPLACEMENT_CANDIDATES` are offered anyway — a hold far away
 * is still a better answer than a sheet with nothing to tap.
 *
 * Holds already in the climb are never offered: swapping one in would quietly
 * change its role somewhere else on the route.
 */
export function rankReplacementCandidates({
  ghost,
  liveHolds,
  paintedHoldIds,
  suggestedHoldIds = [],
  limit = MAX_REPLACEMENT_CANDIDATES,
}: {
  ghost: HoldCircle;
  liveHolds: readonly HoldCircle[];
  paintedHoldIds: ReadonlySet<number>;
  suggestedHoldIds?: readonly number[];
  limit?: number;
}): ReplacementCandidate[] {
  const suggested = new Set(suggestedHoldIds);
  const successors: ReplacementCandidate[] = [];
  const others: ReplacementCandidate[] = [];
  for (const hold of liveHolds) {
    if (hold.id === ghost.id || paintedHoldIds.has(hold.id)) continue;
    const isSuccessor = hold.movedFromHoldId === ghost.id || suggested.has(hold.id);
    const candidate = { holdId: hold.id, distance: centreDistance(ghost, hold), isSuccessor };
    (isSuccessor ? successors : others).push(candidate);
  }
  const byDistance = (left: ReplacementCandidate, right: ReplacementCandidate) =>
    left.distance - right.distance || left.holdId - right.holdId;
  successors.sort(byDistance);
  others.sort(byDistance);

  const nearbyLimit = ghost.r * NEARBY_RADIUS_MULTIPLIER;
  const nearby = others.filter((candidate) => candidate.distance <= nearbyLimit);
  const rest = nearby.length > 0 || successors.length > 0 ? nearby : others.slice(0, FALLBACK_REPLACEMENT_CANDIDATES);
  return [...successors, ...rest].slice(0, limit);
}

/**
 * Paint `holdId` into each placement's frame with that frame's role.
 *
 * Returns `frames` itself when nothing changed: every placement pointed past the
 * last frame, or every frame already had its two starts / finishes. A placement
 * the cap refuses in one frame does not stop the others.
 */
export function applyHoldPlacements(
  frames: LitUpHoldsMap[],
  boardName: BoardName,
  holdId: number,
  placements: readonly HoldPlacement[],
): LitUpHoldsMap[] {
  let next = frames;
  for (const placement of placements) {
    const frame = next[placement.frameIndex];
    if (!frame) continue;
    const painted = applyHoldState(frame, boardName, holdId, placement.state);
    if (painted === frame) continue;
    if (next === frames) next = [...frames];
    next[placement.frameIndex] = painted;
  }
  return next;
}
