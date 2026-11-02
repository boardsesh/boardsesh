import type { ClimbQueueItem } from '@boardsesh/queue';
import { readHeldQueueItemUuid } from '../../lib/held-climb-reader';
import { isDrivingWall } from './use-climb-change-lights';
import { isCommittedHeadClimb } from './wall-state';

/**
 * Where a pick of a queue entry lands: a queue sheet row or suggestion, or a
 * History row's Replay from here.
 *
 * - `commit`: the entry goes up now.
 * - `reopen`: the player shows the climb up as it is (`reopensCurrent`). No
 *   write and nothing lights; a held climb offers Put on the wall.
 * - `preview`: a preview of the entry, which carries the pick to Put on board.
 */
export type QueuePickLanding = 'commit' | 'reopen' | 'preview';

/**
 * While this phone drives the wall (a swipe, Put on board, or Light
 * automatically), every pick commits. Otherwise (preview-first) a pick previews, except a pick of
 * the climb already up: the commit bar compares climbs, not entries
 * (`isCommittedHeadClimb`), so its preview would show no Put on board and the
 * pick could never land. That pick:
 *
 * - commits solo with no #4979 hold. The entry moves into Now. In the same
 *   orientation the wall keeps its climb; a copy in the other orientation
 *   lights it that way, as the tap did before 2.7. A preview of that copy
 *   would show the picked orientation while the board control held only the
 *   climb up's, so it could never go up.
 * - reopens the climb up for the Now slot itself (a commit would only restart
 *   its clock), in a crew (a look never writes the crew's queue), and while
 *   the hold keeps the wall dark (a new current releases the hold, and the
 *   auto-sender lights the wall). The player then shows the climb up in its
 *   own orientation, which is what the wall holds.
 */
export function resolveQueuePickLanding({
  picked,
  current,
  lightsOnPick,
  inSharedSession,
  heldQueueItemUuid,
}: {
  picked: ClimbQueueItem;
  current: ClimbQueueItem | null;
  lightsOnPick: boolean;
  inSharedSession: boolean;
  heldQueueItemUuid: string | null;
}): QueuePickLanding {
  if (lightsOnPick) return 'commit';
  if (!current || !isCommittedHeadClimb(picked.climb.uuid, current.climb.uuid)) return 'preview';
  if (picked.uuid === current.uuid || inSharedSession || heldQueueItemUuid === current.uuid) return 'reopen';
  return 'commit';
}

/** `resolveQueuePickLanding` as it reads at the tap: driving and the hold right now. */
export function readQueuePickLanding(
  picked: ClimbQueueItem,
  { current, inSharedSession }: { current: ClimbQueueItem | null; inSharedSession: boolean },
): QueuePickLanding {
  return resolveQueuePickLanding({
    picked,
    current,
    lightsOnPick: isDrivingWall(),
    inSharedSession,
    heldQueueItemUuid: readHeldQueueItemUuid(),
  });
}
