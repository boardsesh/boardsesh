import { useSuspectedCrewHolder } from '../../providers/crew-holder-suspicion-store';
import { deriveCrewHolderUnconfirmed } from '../play-drawer/lightbulb-control';

/**
 * A crewmate is very likely driving the wall, but presence hasn't confirmed a
 * holder yet ({@link deriveCrewHolderUnconfirmed}). The suspicion, its
 * catch-ups and its release live once in `CrewHolderSuspicionSync`; this
 * adds what only this phone knows: its own link and its own stale hold.
 *
 * False with no owner mounted.
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
  const suspectedHolderUserId = useSuspectedCrewHolder();
  return deriveCrewHolderUnconfirmed({
    suspected: suspectedHolderUserId !== null,
    localConnected,
    holderIsAuthoritative,
    wallSenderUserId: suspectedHolderUserId,
    lastLocalHolderUserId,
  });
}
