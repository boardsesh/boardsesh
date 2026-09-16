/**
 * The ring contract, as the BACKEND applies it — one predicate, shared.
 *
 * `packages/backend/src/validation/schemas/spray-walls.ts` builds
 * `SprayOutlineRingSchema` out of three Zod bounds and one `.refine`, and the
 * refine is `isValidOutlineRing` from `@boardsesh/board-art-geometry/ring`. The
 * Zod bounds in front of it are there so the common failures come back naming
 * themselves; they check nothing the refine does not.
 *
 * So the whole contract is that one shared function, and this module calls it
 * rather than restating it. Restating it is the specific failure to avoid: a
 * client that re-implements "3 to 150 points, every coordinate within 4 radii"
 * drifts the day either bound moves, and the symptom is an editor that draws a
 * silhouette, previews it, and then gets it refused by the server with a
 * validation error the climber can do nothing about.
 *
 * Deliberately NOT the centre-cover test. `ringCoversCentre` in `stroke.ts`
 * mirrors the `hold_outline_overrides` resolver's softened gate; the spray
 * schema has no such rule, because on a wall the owner draws the hold AND its
 * outline in one stroke and the centre is derived from the ring rather than
 * given. Folding one into the other here would reject rings the server takes.
 */

import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';

/**
 * Would the backend's `SprayOutlineRingSchema` accept this ring?
 *
 * Every ring the editor is about to put on the wire goes through here first, so
 * a ring that cannot be stored is dropped to `null` (the renderer's circle
 * fallback, which is a correct answer) instead of failing the whole batch.
 */
export function passesBackendRingContract(ring: readonly number[] | null | undefined): ring is number[] {
  if (ring == null) return false;
  return isValidOutlineRing(ring);
}

/**
 * The outline to send for a hold: the ring itself when it is storable, `null`
 * when it is not.
 *
 * `null` rather than a throw or an omission because it is exactly what the
 * column means — a hold with no traced silhouette, drawn as the circle
 * `(cx, cy, r)` describes. A hold whose outline did not survive a homography,
 * a merge, or a scribble too detailed to decimate is still a hold, and losing
 * the hold over its silhouette would be the worse answer.
 */
export function ringForTheWire(ring: readonly number[] | null | undefined): number[] | null {
  return passesBackendRingContract(ring) ? [...ring] : null;
}
