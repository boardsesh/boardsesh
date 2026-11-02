import type { ClimbQueueItem } from '@boardsesh/queue';
import { readHeldQueueItemUuid } from '../../lib/held-climb-reader';
import { readClimbChangeLights } from './use-climb-change-lights';
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
 * With automatic lighting opted in, or this phone driving, every pick commits.
 * Otherwise (preview-first, the 2.7 default) a pick previews, except a pick of
 * the climb already up: the commit bar compares climbs, not entries
 * (`isCommittedHeadClimb`), so its preview would show no Put on board and the
 * pick could never land. That pick:
 *
 * - commits when nothing on the wall would change: solo, the same orientation,
 *   and no #4979 hold. The entry moves into Now and the wall keeps its climb.
 * - reopens the climb up for the Now slot itself (a commit would only restart
 *   its clock), in a crew (a look never writes the crew's queue), and while
 *   the hold keeps the wall dark (a new current releases the hold, and the
 *   auto-sender lights the wall).
 * - previews in the other orientation, which would light the wall mirrored.
 *   Its preview has no Put on board either, as before 2.7.
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
  if ((picked.climb.mirrored === true) !== (current.climb.mirrored === true)) return 'preview';
  if (picked.uuid === current.uuid || inSharedSession || heldQueueItemUuid === current.uuid) return 'reopen';
  return 'commit';
}

/** `resolveQueuePickLanding` as it reads at the tap: the lighting rule and the hold right now. */
export function readQueuePickLanding(
  picked: ClimbQueueItem,
  { current, inSharedSession }: { current: ClimbQueueItem | null; inSharedSession: boolean },
): QueuePickLanding {
  return resolveQueuePickLanding({
    picked,
    current,
    lightsOnPick: readClimbChangeLights('tap', { inSharedSession }),
    inSharedSession,
    heldQueueItemUuid: readHeldQueueItemUuid(),
  });
}
