import { useContext, useEffect } from 'react';
import { BoardPresenceActionsContext, BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useQueueSessionControls } from '../../providers/queue-provider';
import { usePresenceFresh } from '../../lib/board-presence/presence-freshness';
import { deriveCrewHolderUnconfirmed } from '../play-drawer/lightbulb-control';

/**
 * A crewmate is very likely driving the wall, but presence hasn't confirmed a
 * holder yet ({@link deriveCrewHolderUnconfirmed}). While it is true the feed
 * is asked to catch up once, so its holder refresh confirms the crewmate (the
 * bulb then reads their board as usual) or a free board (the connect comes
 * back) within one round trip, instead of waiting for the next wall event.
 *
 * Reads are non-throwing: outside a board-presence provider there is no
 * presence, so this is false.
 */
export function useCrewHolderUnconfirmed({
  localConnected,
  holderIsAuthoritative,
  lastLocalHolderUserId,
}: {
  localConnected: boolean;
  holderIsAuthoritative: boolean;
  lastLocalHolderUserId: string | null;
}): boolean {
  const current = useContext(BoardPresenceCurrentContext);
  const refresh = useContext(BoardPresenceActionsContext)?.refresh;
  const { sessionId, sessionMemberUserIds } = useQueueSessionControls();
  const wallClimb = current?.currentClimb ?? null;
  const wallPresenceFresh = usePresenceFresh(wallClimb?.sentAt ?? null);
  const unconfirmed = deriveCrewHolderUnconfirmed({
    inSession: sessionId !== null,
    localConnected,
    holderIsAuthoritative,
    holder: current?.holder ?? null,
    lastConnectionSeq: current?.lastConnectionSeq ?? 0,
    wallSenderUserId: wallClimb?.sentByUserId ?? null,
    wallPresenceFresh,
    sessionMemberUserIds,
    lastLocalHolderUserId,
  });
  useEffect(() => {
    // A holder we suspect the feed missed, like the climbs a seq gap repairs.
    if (unconfirmed) refresh?.('gap');
  }, [unconfirmed, refresh]);
  return unconfirmed;
}
