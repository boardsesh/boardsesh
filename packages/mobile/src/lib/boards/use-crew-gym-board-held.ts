import { useContext } from 'react';
import { BoardPresenceClientContext, useBoardConnectionHolder } from '@boardsesh/board-presence-react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardUuidOrNull } from './board-identity';
import { useIsAppBackgrounded } from '../app-visibility';
import { selectEffectiveOffline, useConnectivityField } from '../connectivity/use-connectivity';
import { subscribeWsConnectionEnded } from '../graphql/ws-client-lifecycle';

/**
 * Whether a session member holds the gym board the player is showing. The
 * active board's presence belongs to this phone's selected wall, which may be
 * a different board. A session path alone only says where someone intended to
 * connect: cancelling the picker must leave Put on {board} available (#7181).
 *
 * Pass null unless the session names this target. At most one extra board feed
 * is read, with the shared hook owning snapshot/live ordering and reconnects.
 * Background, offline and socket-end signals invalidate authority immediately;
 * a new snapshot or holder event must confirm the board before it relays again.
 */
export function useCrewGymBoardHeld(
  board: Pick<UserBoard, 'boardId' | 'uuid'> | null,
  sessionMemberUserIds: ReadonlySet<string>,
): boolean {
  const client = useContext(BoardPresenceClientContext)?.client ?? null;
  const backgrounded = useIsAppBackgrounded();
  const effectiveOffline = useConnectivityField(selectEffectiveOffline);
  const { holder, confirmed } = useBoardConnectionHolder({
    boardId: board?.boardId ?? null,
    boardUuid: boardUuidOrNull(board?.uuid),
    client,
    enabled: !backgrounded && !effectiveOffline,
    subscribeInvalidation: subscribeWsConnectionEnded,
  });
  const holderUserId = holder?.userId ?? null;
  return confirmed && holderUserId !== null && sessionMemberUserIds.has(holderUserId);
}
