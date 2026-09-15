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
  /** When the registry took this payload. Distinguishes a post-save refetch from a photo refresh. */
  registeredAtMs?: number;
  holds: readonly {
    id: number;
    cx: number;
    cy: number;
    r: number;
    outline?: number[];
    /** Absent on a payload written before provenance was carried; manual is the honest default. */
    source?: 'MANUAL' | 'AUTO';
    confidence?: number | null;
  }[];
};

export type SeedDecisionInput = {
  /** Identity of the WALL AND VERSION on screen, or null. Not the detector run. */
  seedKey: string | null;
  /** What the editor last seeded from, or null if it has seeded nothing. */
  seededKey: string | null;
  /** The registry payload now. */
  wall: SeedableWall | null;
  /** The exact payload object the editor last seeded from. */
  seededWall: SeedableWall | null;
  /** A different detector run has arrived since the last seed. */
  candidatesChanged: boolean;
  /** A save landed and its refetch has not been seen yet. */
  awaitingSavedPayload: boolean;
  /** When that save was sent, so a payload older than it cannot be mistaken for its answer. */
  saveStartedAtMs: number | null;
};

/** Why the editor is about to re-read the wall, or `null` for "it is not". */
export type SeedReason = 'new-version' | 'new-candidates' | 'saved-payload';

/**
 * Should the editor throw away its state and re-read the wall — and why?
 *
 * The reason is not decoration: it decides whether the detector's proposals are
 * injected again. A new version or a new run brings them; the answer to our own
 * save does not, because by then the accepted ones ARE holds on the draft and
 * re-injecting them would draw each twice and let it be written again.
 *
 * Identity comparison on `wall` is deliberate and load-bearing: the registry
 * hands out a fresh object per registration, so a payload that is `===` the one
 * already seeded is, by construction, the pre-save one. `registeredAtMs` closes
 * the rest of that window — a presigned-photo refresh landing between the save
 * and its refetch produces a NEW object holding OLD holds, and only the
 * timestamp can tell the two apart.
 */
export function seedReason(input: SeedDecisionInput): SeedReason | null {
  const { seedKey, seededKey, wall, seededWall, candidatesChanged, awaitingSavedPayload, saveStartedAtMs } = input;
  if (!wall || seedKey == null) return null;
  // A wall or a version this editor has never read.
  if (seededKey !== seedKey) return 'new-version';
  // A different detector run over the same version.
  if (candidatesChanged) return 'new-candidates';
  if (!awaitingSavedPayload || wall === seededWall) return null;
  // A payload registered before the save was sent cannot be its answer.
  if (saveStartedAtMs != null && wall.registeredAtMs != null && wall.registeredAtMs < saveStartedAtMs) return null;
  return 'saved-payload';
}

/** Does a re-seed for this reason re-offer the detector's proposals? */
export function seedIncludesCandidates(reason: SeedReason): boolean {
  return reason !== 'saved-payload';
}

/**
 * The wall identity a seed decision is made against: the WALL and its VERSION,
 * and nothing else.
 *
 * The detector run is deliberately not folded in. A key carrying the candidate
 * COUNT reads a fresh run of the same length as "no change" — so updated
 * proposals never appear — and reads a run of a different length as a new
 * VERSION, which resets the saved-this-version latch and lets already-accepted
 * candidates back into the pending list.
 */
export function sprayEditorSeedKey(wall: SeedableWall | null): string | null {
  return wall ? `${wall.wallUuid}:${wall.version}` : null;
}

/**
 * The editor's starting holds: the wall's own, plus the detector's proposals,
 * plus anything this session has changed that the server has not taken yet.
 *
 * Stored holds arrive clean and accepted — they ARE the wall — and carry the
 * provenance the server has for them. Hardcoding MANUAL here would mean that
 * nudging an accepted detector hold re-submitted it as hand-drawn, quietly
 * overwriting what the wall records about where its holds came from.
 *
 * `includeCandidates` is false when the re-seed is the answer to our own save.
 * By then the accepted ones are holds on the draft and come back in
 * `wall.holds`, so re-injecting the list would draw every one of them twice and
 * let it be written again — and the rejected ones would come back from the dead.
 *
 * `carryOver` is the half that keeps a partial save honest. A plan can succeed
 * while leaving holds out of it — one the homography sends off the wall, or one
 * drawn while a slow save was in flight — and the editor says so. Those holds
 * are still dirty, and dropping them on the re-seed would delete work the UI had
 * just promised was still there. A carried hold with a server id REPLACES the
 * server's copy (this session's geometry is the newer one); a carried hold with
 * a local id is appended, because the server has never seen it.
 */
export function buildEditorSeed(
  wall: SeedableWall,
  candidates: readonly SprayHoldCandidate[],
  includeCandidates: boolean,
  carryOver: readonly SprayEditorHold[] = [],
): SprayEditorHold[] {
  const byId = new Map<number, SprayEditorHold>();
  for (const hold of wall.holds) {
    byId.set(hold.id, {
      id: hold.id,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
      outline: hold.outline ? [...hold.outline] : null,
      source: hold.source === 'AUTO' ? 'AUTO' : 'MANUAL',
      confidence: hold.confidence ?? null,
      review: 'accepted',
      dirty: false,
    });
  }

  if (includeCandidates) {
    let nextLocalId = -1;
    for (const candidate of candidates) {
      const id = nextLocalId--;
      byId.set(id, {
        id,
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
  }

  for (const hold of carryOver) {
    byId.set(hold.id, hold);
  }

  return [...byId.values()];
}

/**
 * The holds a re-seed has to carry: everything this session changed that the
 * last save did not take.
 *
 * A pending candidate is never carried — it is a proposal, and the fresh payload
 * brings its own.
 */
export function holdsToCarryOver(holds: readonly SprayEditorHold[]): SprayEditorHold[] {
  return holds.filter((hold) => hold.dirty && hold.review !== 'pending');
}
