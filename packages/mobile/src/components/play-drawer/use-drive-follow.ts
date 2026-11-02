import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeToWallConfirm } from '@boardsesh/play-view';
import { useActiveClimbUuid, useQueueActions } from '../../providers/queue-provider';
import { announceQueued } from '../../lib/announce-queued';
import { hapticLight, hapticSuccess } from '../../lib/haptics';
import { subscribeCrewMoves } from '../../lib/relay-receipt';
import { clearCrewPutUp, formatCrewPutUp, resolveCrewPutUp, showCrewPutUp } from './crew-put-up-store';
import { exitDriveMode, getDriveMode, markDriveLive, noteDriveClimbLit, type DriveModePhase } from './drive-mode-store';

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
 * Put on board's timed drive (2.7) is different: it lights this phone's own
 * picks, so a crewmate's put-up ends it (`window_ended`). The auto-sender
 * still lights their climb, and this phone's next pick is a preview again,
 * with the busy-wall question in front of Put on board. A crewmate's relay
 * never renews the drive, or the holder's next swipe could take the wall back
 * from the crewmate at it. With Disconnect Bluetooth when driving ends on, the
 * board is let go once their climb is on the wall (`waitForWallConfirm`, for
 * that climb only), so it isn't dropped before it lights.
 *
 * A timed drive a Lock Screen press started while JS was suspended (2.7) is
 * this phone's drive too, so `beforeCrewMove` adopts it first
 * (`adoptLockScreenLighting`) and the put-up ends it like any other. Left
 * unadopted, the next adoption (the app coming back) would bring it back after
 * the put-up. The climber's own Lock Screen press is never a crewmate's move:
 * the server names them as its mover (`currentChangedBy`).
 *
 * It reads the current climb through `useActiveClimbUuid` (a change of climb)
 * and the queue snapshot, so the app-root watcher doesn't re-render on every
 * queue change.
 */
/**
 * After a crewmate's put-up ended a timed drive, the longest the board is held
 * for their climb to reach the wall before it is let go anyway (a write that
 * failed, or the #4979 hold keeping it dark).
 */
export const CREW_PUT_UP_DISCONNECT_WAIT_MS = 5_000;

/**
 * Resolves at the next wall confirm of a climb `matches` accepts, from this
 * phone's link or a relay, or after `timeoutMs`. The confirm bus also replays
 * the session's confirms (any member's relay, or a late echo of this phone's
 * own earlier one), so a wait for one climb names it: another climb's confirm
 * never ends it early. A write of it still in flight on this link is waited
 * for after that (`use-driving-ended-disconnect.ts`).
 */
export function waitForWallConfirm(timeoutMs: number, matches: (climbUuid: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const done = () => {
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    unsubscribe = subscribeToWallConfirm((climbUuid) => {
      if (matches(climbUuid)) done();
    });
  });
}

type QueueSnapshotRead = {
  queue: readonly { uuid: string; climb: { uuid: string } }[];
  currentClimbQueueItem: { uuid: string; climb: { uuid: string } } | null;
};

/** The climb a queue item holds, read when it is needed: a crewmate's move can arrive before its item does. */
export function climbUuidOfQueueItem(snapshot: QueueSnapshotRead, queueItemUuid: string): string | null {
  if (snapshot.currentClimbQueueItem?.uuid === queueItemUuid) return snapshot.currentClimbQueueItem.climb.uuid;
  return snapshot.queue.find((item) => item.uuid === queueItemUuid)?.climb.uuid ?? null;
}

export function useDriveCrewPutUp(drivePhase: DriveModePhase | null, beforeCrewMove?: () => void): void {
  const { t } = useTranslation('session');
  const activeClimbUuid = useActiveClimbUuid();
  const { getQueueSnapshot } = useQueueActions();
  const getQueueSnapshotRef = useRef(getQueueSnapshot);
  getQueueSnapshotRef.current = getQueueSnapshot;
  // The crewmate's move, by the queue item it makes current, until it lands.
  const pendingRef = useRef<string | null>(null);
  const beforeCrewMoveRef = useRef(beforeCrewMove);
  beforeCrewMoveRef.current = beforeCrewMove;

  useEffect(
    () =>
      subscribeCrewMoves((queueItemUuid) => {
        beforeCrewMoveRef.current?.();
        const drive = getDriveMode();
        if (drive?.windowMs != null) {
          exitDriveMode('window_ended', {
            disconnectAfter: () =>
              waitForWallConfirm(
                CREW_PUT_UP_DISCONNECT_WAIT_MS,
                (climbUuid) => climbUuidOfQueueItem(getQueueSnapshotRef.current(), queueItemUuid) === climbUuid,
              ),
          });
          return;
        }
        if (drive?.phase === 'live') pendingRef.current = queueItemUuid;
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
 * Drive the arming → live step and count the climbs a drive lights, from this
 * phone's own confirms on the wall-confirm bus (`@boardsesh/play-view`): its
 * auto-sender confirms each climb its link actually lit (`handleWallConfirmed`
 * in the Bluetooth provider, origin `'self'`).
 *
 * A relay (the session feed's `WallConfirmedClimb`) is ignored. It is a
 * crewmate's confirm, or an echo of one this phone already counted, so it
 * never proves this phone's link lit the swipe's climb: a crewmate lighting
 * their own wall must not take this phone's arming drive live, start its
 * clock, or renew it. A relay also never marks a climb counted, so this
 * phone's own confirm of the same climb still counts.
 *
 * - Arming goes live, with a success buzz, at this phone's first own confirm
 *   while it holds the link: the swipe's climb is lit. Here at the app root, so
 *   closing the player mid-connect still goes live.
 * - Each own confirm of a climb other than the last one counted is one more
 *   climb lit (a re-send of the same climb is not), the swipe's own first.
 */
export function useDriveWallConfirms(linked: boolean): void {
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  // The drive (by its start) and the last climb counted for it.
  const lastCountedRef = useRef<{ startedAt: number; climbUuid: string } | null>(null);

  useEffect(
    () =>
      subscribeToWallConfirm((climbUuid, origin) => {
        if (origin !== 'self') return;
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
