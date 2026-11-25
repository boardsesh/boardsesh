import type { GroupedNotification } from '@boardsesh/shared-schema';

/** A `board_access_requested` row the owner can answer in place: one climber asking. */
export function isAnswerableBoardAccessRequest(notification: GroupedNotification): boolean {
  return (
    notification.type === 'board_access_requested' &&
    notification.actorCount === 1 &&
    notification.actors.length > 0 &&
    !!notification.entityId
  );
}
