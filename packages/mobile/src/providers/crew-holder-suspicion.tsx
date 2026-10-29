import { useContext, useEffect, useRef, useState } from 'react';
import { BoardPresenceActionsContext, BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { deriveCrewHolderSuspected } from '../components/play-drawer/lightbulb-control';
import { usePresenceFresh } from '../lib/board-presence/presence-freshness';
import { useViewerUserId } from '../hooks/use-viewer-user-id';
import { useQueueSessionControls } from './queue-provider';
import { publishSuspectedCrewHolder } from './crew-holder-suspicion-store';

/**
 * How long a suspected crewmate's hold blocks this phone's connect without a
 * holder event confirming it (#7017 review). A wrong suspicion must never
 * strand a climber unable to light the board, so past this it is released and
 * the bulb connects as before.
 */
export const CREW_HOLDER_CONFIRM_MS = 10_000;

/** When the holder is re-read while the suspicion stands: at once, then backing off, all inside the window. */
export const CREW_HOLDER_RETRY_DELAYS_MS: readonly number[] = [0, 2_000, 6_000];

/**
 * The session member board presence suggests is driving the wall before any
 * holder event has named one (`deriveCrewHolderSuspected`), or `null`.
 *
 * Owned once for the app, so the catch-ups it asks for fire once whatever
 * number of bulbs are mounted, under their own telemetry reason. While the
 * suspicion stands the feed's holder is re-read on `CREW_HOLDER_RETRY_DELAYS_MS`;
 * a refresh that fails says nothing, so the release at `CREW_HOLDER_CONFIRM_MS`
 * is the floor. A suspicion is released once per session and crewmate.
 *
 * Never this climber's own account: a climb they lit on this phone before a
 * relaunch, or on another device, is not a crewmate's hold. A named holder
 * says "On your other phone" instead.
 */
export function useCrewHolderSuspicion(): string | null {
  const current = useContext(BoardPresenceCurrentContext);
  const refresh = useContext(BoardPresenceActionsContext)?.refresh;
  const { sessionId, sessionMemberUserIds } = useQueueSessionControls();
  const viewerUserId = useViewerUserId();
  const wallClimb = current?.currentClimb ?? null;
  const sender = wallClimb?.sentByUserId ?? null;
  const wallPresenceFresh = usePresenceFresh(wallClimb?.sentAt ?? null);
  const suspected = deriveCrewHolderSuspected({
    inSession: sessionId !== null,
    holder: current?.holder ?? null,
    lastConnectionSeq: current?.lastConnectionSeq ?? 0,
    wallSenderUserId: sender,
    wallPresenceFresh,
    sessionMemberUserIds,
    viewerUserId,
  });
  // A board switch resets presence, so the session and the crewmate name a suspicion.
  const key = suspected ? `${sessionId ?? ''}|${sender ?? ''}` : null;
  const [releasedKey, setReleasedKey] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (key === null || key === releasedKey) return undefined;
    const timers = CREW_HOLDER_RETRY_DELAYS_MS.map((delay) =>
      setTimeout(() => refreshRef.current?.('crew-holder-unconfirmed'), delay),
    );
    timers.push(setTimeout(() => setReleasedKey(key), CREW_HOLDER_CONFIRM_MS));
    return () => timers.forEach(clearTimeout);
  }, [key, releasedKey]);

  return key !== null && key !== releasedKey ? sender : null;
}

/** The one owner: computes the suspicion and publishes it to every bulb. Mounted once, in the root layout. */
export function CrewHolderSuspicionSync(): null {
  const suspected = useCrewHolderSuspicion();
  useEffect(() => {
    publishSuspectedCrewHolder(suspected);
  }, [suspected]);
  useEffect(() => () => publishSuspectedCrewHolder(null), []);
  return null;
}
