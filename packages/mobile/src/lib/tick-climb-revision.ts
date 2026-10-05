import { knownClimbRevision } from '@boardsesh/logbook';

/**
 * Which climb version a tick may name (#6023). Pure, so the tick form, the
 * network enrichment and their tests all use the same rule.
 *
 * The rule behind every function here: the server stores any in-range version
 * the app sends, as sent. A wrong number therefore does more harm than a
 * missing one. A missing number makes the server store the version that was
 * live when the climb was climbed, which is right for a tick logged now. A
 * wrong one files the send under a version the climber was not on, and if the
 * holds have moved since, the send stops counting. So a number is used only
 * when the app can show it belongs to the holds on screen, and left out
 * otherwise.
 */

/** What the phone's own copy of a climb says: its holds and its version. */
export type LocalClimbVersionWitness = {
  /** `board_climbs.frames` of the phone's row. */
  frames: string | null;
  /** `board_climbs.revision_number` of the same row; null when not known. */
  revisionNumber: number | null;
};

/**
 * The phone's version of a climb, but only when the phone's row has the same
 * holds as the climb on screen. Null otherwise.
 *
 * The phone's row is one past state of the climb. The climb on screen can be
 * another: a network answer newer than the last pull, a queue item from before
 * an edit, or unsaved work in the editor. Naming the phone's version for those
 * would stamp the tick with a version it was not climbed on.
 *
 * Compared as exact strings. Two strings that list the same holds in a
 * different order compare unequal here, where the server's `holdsMoved` would
 * call them the same. That only errs toward leaving the number out, which is
 * the safe side, and it keeps the server's hold parser out of the app.
 */
export function localRevisionMatchingFrames(
  local: LocalClimbVersionWitness | null | undefined,
  displayedFrames: string | null | undefined,
): number | null {
  if (!local || !displayedFrames || !local.frames) return null;
  if (local.frames !== displayedFrames) return null;
  return knownClimbRevision(local.revisionNumber);
}

/**
 * The version to send with a tick, or null to send none.
 *
 * `displayedRevision` is the number the climb on screen carries. It was read
 * together with the frames on screen (a local search row, or a network row
 * that already passed `localRevisionMatchingFrames`), so it is used as it is.
 * Without it, the phone's copy answers, under the same frames check.
 */
export function resolveTickClimbRevision(input: {
  displayedRevision: number | null | undefined;
  displayedFrames: string | null | undefined;
  local: LocalClimbVersionWitness | null | undefined;
}): number | null {
  return knownClimbRevision(input.displayedRevision) ?? localRevisionMatchingFrames(input.local, input.displayedFrames);
}
