import { canAccessResource, canViewActivityIdentity } from '../privacy';
import { canReadClimbContent } from '../board-session-privacy';
import { deriveBoardConnection, type BoardHolder } from './board-connection';
import type { LiveActivityContentState } from './index';

import { emptyLiveActivityContentState } from './content-state';

export async function projectLiveActivityContent(
  sessionId: string,
  viewerId: string | null,
  contentState: LiveActivityContentState,
  holder: BoardHolder | null,
): Promise<{ event: 'update' | 'end'; contentState: LiveActivityContentState }> {
  if (!(await canAccessResource('session', sessionId, viewerId))) {
    return { event: 'end', contentState: emptyLiveActivityContentState() };
  }
  const readableClimb = !!contentState.climbUuid && (await canReadClimbContent(contentState.climbUuid, viewerId));
  const projected: LiveActivityContentState = readableClimb
    ? { ...contentState }
    : {
        ...contentState,
        climbName: '',
        climbDifficulty: '',
        climbUuid: '',
        queueItemUuid: '',
        mirrored: false,
      };
  // Neither a cached name nor an omitted optional field may restore a previous
  // private holder name in a device's existing Live Activity state.
  delete projected.boardConnection;
  projected.holderDisplayName = '';
  if (holder) {
    const showIdentity =
      !!holder.holderUserId && (await canViewActivityIdentity(holder.holderUserId, viewerId, { sessionId }));
    Object.assign(
      projected,
      deriveBoardConnection({
        tokenUserId: viewerId,
        holderUserId: holder.holderUserId,
        holderDisplayName: showIdentity ? holder.holderDisplayName : null,
      }),
    );
  }
  return { event: 'update', contentState: projected };
}
