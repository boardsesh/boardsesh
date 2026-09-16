// What the create-climb editor does differently on a spray wall (issue #5443).
//
// The editor is board-agnostic once `create-board-holds.ts` knows the holds and
// `getBoardCapabilities` allows authoring — SW-07 made both true for a wall. What
// is left is four rules a wall answers differently from a catalogue board, and
// they live here as pure functions so the controller reads as one branch per rule
// and every branch is table-testable without a renderer:
//
//  1. **A setter grade is required to publish.** `crowdGrade: false` means there
//     is no consensus grade to converge on — a handful of people ever climb a
//     home wall — so a published climb with no grade stays ungraded forever. The
//     server refuses it (`assertSprayGradeOnPublish`); this is the client half,
//     which says so BEFORE the round trip.
//  2. **Feet are open by default.** A spray wall is a field of holds with no
//     "kicker" and no set-piece feet, and the overwhelming convention on one is
//     that anything goes for feet. The toggle stays visible — a setter can mark
//     feet — and rule 3 keeps the two honest.
//  3. **Marking a foot hold answers the same question the toggle does.** So the
//     toggle follows the paint: the first FOOT hold turns "any feet" off, and
//     clearing the last one turns it back on. In between the setter may still
//     override it by hand; only a CHANGE in whether the climb marks feet moves it.
//  4. **The angle is the wall's, not the caller's.** A wall does not adjust, so
//     the route params (which a deep link can hand-edit, and which the active
//     board fills in) are not authoritative — the registered wall is.
//
// Every function here takes the board name, so a catalogue board falls through
// with today's behaviour rather than needing a `boardName !== 'spray'` at each
// call site.

import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { getSprayWall, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';

/** True for the one board type these rules apply to. */
export function isSprayBoard(boardName: string): boolean {
  return boardName === SPRAY_BOARD_NAME;
}

/**
 * Whether publishing on this board needs the setter's own grade.
 *
 * Spray only. MoonBoard has no crowd grade either, but its climbs are authored
 * through `saveMoonBoardClimb`, which carries its own grade field and its own
 * form — this editor never publishes one.
 */
export function requiresSetterGrade(boardName: string): boolean {
  return isSprayBoard(boardName);
}

/** Where the "any feet" switch starts on a fresh climb. */
export function defaultAnyFeet(boardName: string): boolean {
  return isSprayBoard(boardName);
}

/** Does the working frame mark any foot holds? */
export function hasFootHolds(litUpHoldsMap: LitUpHoldsMap): boolean {
  for (const hold of Object.values(litUpHoldsMap)) {
    if (hold.state === 'FOOT') return true;
  }
  return false;
}

/**
 * Where the "any feet" switch lands after the climb gained or lost its foot
 * holds.
 *
 * Only a CHANGE moves it. A setter who marks two feet and then turns "any feet"
 * back on has said something the paint cannot say, and re-deriving the switch on
 * every render would silently undo them on the next keystroke. `previousHasFeet`
 * is `null` on the first evaluation of a session — a fork or a restored draft
 * arrives with both its paint and its stored rules, and neither gets to overrule
 * the other.
 */
export function nextAnyFeetForFeetChange(
  previousHasFeet: boolean | null,
  hasFeet: boolean,
  currentAnyFeet: boolean,
  campus: boolean,
): boolean {
  // "Campus" is the strictest answer to the same question — no feet at all — and
  // it is the one the setter chose explicitly. Clearing the marked feet off a
  // campus climb must not reopen them.
  if (campus) return currentAnyFeet;
  if (previousHasFeet === null) return currentAnyFeet;
  if (previousHasFeet === hasFeet) return currentAnyFeet;
  return !hasFeet;
}

/**
 * The angle a climb authored here must carry.
 *
 * The wall's own, whenever the wall is registered. `assertSprayAngleMatchesWall`
 * rejects anything else outright (rather than coercing it), so sending the route
 * param would turn a stale deep link into a failed publish with nothing the
 * setter can do about it. An unregistered wall falls back to the caller's angle:
 * the editor cannot draw that wall anyway, so there is no publish to protect.
 */
export function authoringAngle(boardName: string, layoutId: number, fallbackAngle: number): number {
  if (!isSprayBoard(boardName)) return fallbackAngle;
  return getSprayWall(layoutId)?.angle ?? fallbackAngle;
}

/**
 * Whether the editor should hold a spinner rather than say it cannot set climbs
 * here.
 *
 * Only ever true for a wall that can actually finish loading. `useSprayWall(null)`
 * reports `idle`, which reads as loading, so keying the spinner on that alone left
 * any catalogue board whose hold table came back empty — a malformed layout/size
 * tuple off a deep link — spinning for ever instead of reaching the unavailable
 * state it used to get.
 */
export function shouldAwaitWall(
  hasBoardHolds: boolean,
  sprayLayoutId: number | null,
  sprayWallLoading: boolean,
): boolean {
  if (hasBoardHolds) return false;
  if (sprayLayoutId === null) return false;
  return sprayWallLoading;
}

/**
 * The wall uuid to present on every spray write, or `undefined`.
 *
 * `SaveClimbInput.sprayWallUuid` is the capability an UNLISTED wall's share link
 * hands out: a layout id comes out of a sequence and authorizes nothing, so
 * without this the crew somebody shared their wall with cannot set climbs on it.
 * Ignored by the server when the caller is the owner or a gym member, so it is
 * sent unconditionally rather than only when it is needed — the client cannot
 * tell which of the three it is.
 */
export function sprayWallUuidFor(boardName: string, layoutId: number): string | undefined {
  if (!isSprayBoard(boardName)) return undefined;
  return getSprayWall(layoutId)?.wallUuid;
}
