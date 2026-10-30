import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueueData } from '../../providers/queue-provider';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { announceQueued } from '../../lib/announce-queued';
import { hapticLight } from '../../lib/haptics';
import { subscribeCrewMoves } from '../../lib/relay-receipt';
import { clearCrewPutUp, formatCrewPutUp, resolveCrewPutUp, showCrewPutUp } from './crew-put-up-store';
import { getDriveMode, noteDriveClimbLit, type DriveModePhase } from './drive-mode-store';
import { useWallClimb } from './use-wall-climb';

/**
 * A crewmate puts a climb up while this phone drives the wall (#7113). This
 * phone's auto-sender lights it like any current climb, the player follows
 * (it shows the current climb), and the drive goes on. This says who: "Sam put
 * up Crimp Ladder" for 4 s where "Only you see this" sits, a light buzz, and
 * one screen-reader announcement.
 *
 * Only a crewmate's move counts (`subscribeCrewMoves`: never this phone's own
 * or its echo), heard while live, and said once the queue has made it current.
 */
export function useDriveCrewPutUp(drivePhase: DriveModePhase | null): void {
  const { t } = useTranslation('session');
  const { currentClimbQueueItem } = useQueueData();
  const viewerUserId = useViewerUserId();
  // The crewmate's move, by the queue item it makes current, until it lands.
  const pendingRef = useRef<string | null>(null);

  useEffect(
    () =>
      subscribeCrewMoves((queueItemUuid) => {
        if (getDriveMode()?.phase === 'live') pendingRef.current = queueItemUuid;
      }),
    [],
  );

  const live = drivePhase === 'live';
  useEffect(() => {
    if (live) return;
    pendingRef.current = null;
    clearCrewPutUp();
  }, [live]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null || currentClimbQueueItem?.uuid !== pending) return;
    pendingRef.current = null;
    if (getDriveMode()?.phase !== 'live') return;
    const notice = resolveCrewPutUp({ item: currentClimbQueueItem, viewerUserId });
    if (!notice) return;
    showCrewPutUp(notice);
    hapticLight();
    announceQueued(formatCrewPutUp(notice, t));
  }, [currentClimbQueueItem, viewerUserId, t]);
}

/**
 * Counts the climbs a live drive lights, for Drive Mode Ended: each new climb
 * on the wall while this phone's link holds it. The swipe's own climb is
 * counted when the drive goes live (`markDriveLive`), so the climb on the wall
 * at that moment is the baseline.
 */
export function useDriveClimbsLit(drivePhase: DriveModePhase | null, linked: boolean): void {
  const wallClimbUuid = useWallClimb().uuid;
  const baselineRef = useRef<string | null>(null);
  const live = drivePhase === 'live';
  useEffect(() => {
    if (!live) {
      baselineRef.current = null;
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = wallClimbUuid ?? '';
      return;
    }
    if (!linked || wallClimbUuid === null || wallClimbUuid === baselineRef.current) return;
    baselineRef.current = wallClimbUuid;
    noteDriveClimbLit();
  }, [live, linked, wallClimbUuid]);
}
