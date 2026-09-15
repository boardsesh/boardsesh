/**
 * When the editor re-reads the wall, and what it reads.
 *
 * Both halves are here, pure, because the seam between "a save landed" and "the
 * payload carrying what the save wrote landed" is the one place this screen can
 * destroy work, and it cannot be tested through a mounted board.
 *
 * The failure it exists to prevent: `invalidateQueries` is not the refetch. A
 * save that bumped a counter and re-seeded on the spot would re-read the
 * registry payload from BEFORE the save — the holds it just added would vanish,
 * the ones it just deleted would come back, and the ids it carried forward would
 * be the superseded ones, so every later save in that session would be refused
 * for the whole batch. So the trigger is not a counter: it is the arrival of a
 * DIFFERENT payload, which is the only evidence that the refetch actually
 * happened.
 *
 * The opposite failure matters just as much. The registry re-registers a wall
 * whenever its presigned photo signature is refreshed, so "the payload changed"
 * cannot seed on its own either — that would throw away the holds somebody is
 * halfway through drawing. A re-seed therefore needs one of two reasons: a
 * version this editor has never seeded, or a save of our own that is still
 * waiting for its payload.
 */

import type { SprayHoldCandidate } from './spray-hold-editor-types';
import type { SprayEditorHold } from './spray-hold-editor-reducer';

/** The shape this module needs off a registered wall — nothing more. */
export type SeedableWall = {
  wallUuid: string;
  version: number;
  holds: readonly { id: number; cx: number; cy: number; r: number; outline?: number[] }[];
};

export type SeedDecisionInput = {
  /** Identity of the wall+version+detector-run currently on screen, or null. */
  seedKey: string | null;
  /** What the editor last seeded from, or null if it has seeded nothing. */
  seededKey: string | null;
  /** The registry payload now. */
  wall: SeedableWall | null;
  /** The exact payload object the editor last seeded from. */
  seededWall: SeedableWall | null;
  /** A save landed and its refetch has not been seen yet. */
  awaitingSavedPayload: boolean;
};

/**
 * Should the editor throw away its state and re-read the wall?
 *
 * Identity comparison on `wall` is deliberate and load-bearing: the registry
 * hands out a fresh object per registration, so a payload that is `===` the one
 * already seeded is, by construction, the pre-save one.
 */
export function shouldSeedEditor(input: SeedDecisionInput): boolean {
  const { seedKey, seededKey, wall, seededWall, awaitingSavedPayload } = input;
  if (!wall || seedKey == null) return false;
  // A wall or a version this editor has never read.
  if (seededKey !== seedKey) return true;
  // Our own save, but only once its payload has actually arrived.
  return awaitingSavedPayload && wall !== seededWall;
}

/** The wall identity a seed decision is made against. */
export function sprayEditorSeedKey(wall: SeedableWall | null, candidateCount: number): string | null {
  return wall ? `${wall.wallUuid}:${wall.version}:${candidateCount}` : null;
}

/**
 * The editor's starting holds: the wall's own, plus the detector's proposals.
 *
 * Stored holds arrive clean and accepted — they ARE the wall. Candidates arrive
 * `pending`, with negative ids, so they are drawn from the first frame and
 * written by nothing until somebody rules on them.
 *
 * `includeCandidates` is false after the first save of a version. By then the
 * accepted ones are holds on the draft and come back in `wallHolds`, so
 * re-injecting the list would draw every one of them twice and let it be written
 * again — and the rejected ones would come back from the dead.
 */
export function buildEditorSeed(
  wall: SeedableWall,
  candidates: readonly SprayHoldCandidate[],
  includeCandidates: boolean,
): SprayEditorHold[] {
  const seeded: SprayEditorHold[] = wall.holds.map((hold) => ({
    id: hold.id,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
    outline: hold.outline ? [...hold.outline] : null,
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
  }));

  if (!includeCandidates) return seeded;

  let nextLocalId = -1;
  for (const candidate of candidates) {
    seeded.push({
      id: nextLocalId--,
      cx: candidate.cx,
      cy: candidate.cy,
      r: candidate.r,
      outline: candidate.outline ? [...candidate.outline] : null,
      source: 'AUTO',
      confidence: candidate.confidence,
      review: 'pending',
      dirty: false,
    });
  }
  return seeded;
}
