import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeToWallConfirm } from '@boardsesh/play-view';
import { useActiveClimbUuid, useQueueActions } from '../../providers/queue-provider';
import { announceQueued } from '../../lib/announce-queued';
import { hapticLight, hapticSuccess } from '../../lib/haptics';
import { subscribeCrewMoves } from '../../lib/relay-receipt';
import { clearCrewPutUp, formatCrewPutUp, resolveCrewPutUp, showCrewPutUp } from './crew-put-up-store';
import { getDriveMode, markDriveLive, noteDriveClimbLit, type DriveModePhase } from './drive-mode-store';

/**
 * A crewmate puts a climb up while this phone drives the wall (#7113). This
 * phone's auto-sender lights it like any current climb, the player follows
 * (it shows the current climb), and the drive goes on. This says so: "Your
 * crew put up Crimp Ladder" for 4 s where "Only you see this" sits, a light
 * buzz, and one screen-reader announcement. It names nobody: the queue item
 * says who added the climb, not who put it up.
 *
 * Only a crewmate's move counts (`subscribeCrewMoves`: never this phone's own
 * or its echo), heard while live, and said once the queue has made it current.
 * Any other change of current climb first drops it: a crewmate's move the
 * driver's own swipe overtook is never said later.
 *
 * It reads the current climb through `useActiveClimbUuid` (a change of climb)
 * and the queue snapshot, so the app-root watcher doesn't re-render on every
 * queue change.
 */
export function useDriveCrewPutUp(drivePhase: DriveModePhase | null): void {
  const { t } = useTranslation('session');
  const activeClimbUuid = useActiveClimbUuid();
  const { getQueueSnapshot } = useQueueActions();
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
    if (pending === null) return;
    // Settled either way: it landed, or another change of climb overtook it.
    pendingRef.current = null;
    const current = getQueueSnapshot().currentClimbQueueItem;
    if (current?.uuid !== pending || getDriveMode()?.phase !== 'live') return;
    const notice = resolveCrewPutUp(current);
    if (!notice) return;
    showCrewPutUp(notice);
    hapticLight();
    announceQueued(formatCrewPutUp(notice, t));
  }, [activeClimbUuid, getQueueSnapshot, t]);
}

/**
 * Drive the arming → live step and count the climbs a drive lights, from the
 * wall-confirm bus (`@boardsesh/play-view`): this phone's auto-sender confirms
 * each climb its link actually lit (`handleWallConfirmed` in the Bluetooth
 * provider), and the crew feed replays the same confirm, never a new climb.
 *
 * - Arming goes live, with a success buzz, at the first confirm while this
 *   phone holds the link: the swipe's climb is lit. Here at the app root, so
 *   closing the player mid-connect still goes live.
 * - Each confirm of a climb other than the last one counted is one more climb
 *   lit (a re-send or an echo of the same climb is not), the swipe's own first.
 */
export function useDriveWallConfirms(linked: boolean): void {
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  // The drive (by its start) and the last climb counted for it.
  const lastCountedRef = useRef<{ startedAt: number; climbUuid: string } | null>(null);

  useEffect(
    () =>
      subscribeToWallConfirm((climbUuid) => {
        const drive = getDriveMode();
        if (!drive || !linkedRef.current) return;
        if (drive.phase === 'arming') {
          markDriveLive();
          hapticSuccess();
        }
        const last = lastCountedRef.current;
        if (last && last.startedAt === drive.startedAt && last.climbUuid === climbUuid) return;
        lastCountedRef.current = { startedAt: drive.startedAt, climbUuid };
        noteDriveClimbLit();
      }),
    [],
  );
}
