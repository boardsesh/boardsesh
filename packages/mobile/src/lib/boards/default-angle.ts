import type { BoardName } from '@boardsesh/shared-schema';
import { ANGLES } from '@boardsesh/board-config';

/**
 * The angle to assume for a board when the caller has none of its own.
 *
 * 40° when the board supports it (the de-facto standard setting on Kilter and
 * Tension), otherwise the board's first supported angle — which is how
 * angle-agnostic boards like the MoonBoard land on their single value.
 *
 * Lifted out of the board builder once a second caller needed it: notification
 * rows carry a climb uuid but no angle (web resolves one server-side via
 * `/api/internal/climb-redirect`, which mobile has no equivalent of), so they
 * fall back to the user's active board angle and then to this.
 */
export function defaultAngle(boardName: BoardName): number {
  const angles = ANGLES[boardName] ?? [];
  return angles.includes(40) ? 40 : (angles[0] ?? 0);
}
